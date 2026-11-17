//! JSONL tokenizer with bounded retained strings/tree, including oversized rows.
//! Never holds a whole physical line. Invalid lines are drained to the next LF.
use serde_json::{Map, Value};
use std::io::BufRead;
pub(super) const STRING_BYTES: usize = 64 * 1024;
pub(super) const ROW_BYTES: usize = 256 * 1024;
pub(super) const NODES: usize = 4096;
pub(super) type Row = (u64, Result<Value, &'static str>, bool);
pub(super) struct Reader<R> {
    input: R,
    pub offset: u64,
    last_lf: bool,
    left: usize,
    nodes: usize,
    pub clipped: bool,
}
impl<R: BufRead> Reader<R> {
    pub fn new(input: R) -> Self {
        Self {
            input,
            offset: 0,
            last_lf: false,
            left: ROW_BYTES,
            nodes: NODES,
            clipped: false,
        }
    }
    fn peek(&mut self) -> Result<Option<u8>, &'static str> {
        self.input
            .fill_buf()
            .map(|b| b.first().copied())
            .map_err(|_| "read")
    }
    fn take(&mut self) -> Result<u8, &'static str> {
        let b = self.peek()?.ok_or("truncated_jsonl")?;
        self.input.consume(1);
        self.offset += 1;
        self.last_lf = b == b'\n';
        Ok(b)
    }
    fn space(&mut self) -> Result<(), &'static str> {
        while self
            .peek()?
            .is_some_and(|b| b == b' ' || b == b'\t' || b == b'\r')
        {
            self.take()?;
        }
        Ok(())
    }
    fn string(&mut self, keep: bool) -> Result<String, &'static str> {
        if self.take()? != b'"' {
            return Err("malformed");
        }
        let cap = if keep { self.left.min(STRING_BYTES) } else { 0 };
        let mut raw = Vec::with_capacity(cap.min(1024));
        raw.push(b'"');
        let mut clipped = false;
        loop {
            // Bulk-consume ordinary ASCII (large base64/text) without allocation.
            let buf = self.input.fill_buf().map_err(|_| "read")?;
            let n = buf
                .iter()
                .position(|b| *b == b'"' || *b == b'\\' || *b < 32 || *b >= 128)
                .unwrap_or(buf.len());
            if n > 0 {
                let copy = n.min(cap.saturating_sub(raw.len()));
                raw.extend_from_slice(&buf[..copy]);
                clipped |= copy < n;
                self.input.consume(n);
                self.offset += n as u64;
                self.last_lf = false;
                continue;
            }
            let b = self.take()?;
            if b == b'"' {
                break;
            }
            if b < 32 {
                return Err(if b == b'\n' {
                    "truncated_jsonl"
                } else {
                    "decode"
                });
            }
            let mut unit = vec![b];
            if b == b'\\' {
                let escape = self.take()?;
                unit.push(escape);
                if escape == b'u' {
                    for _ in 0..4 {
                        unit.push(self.take()?);
                    }
                    let hex = std::str::from_utf8(&unit[2..]).map_err(|_| "decode")?;
                    let code = u16::from_str_radix(hex, 16).map_err(|_| "malformed")?;
                    if (0xD800..=0xDBFF).contains(&code) {
                        if self.take()? != b'\\' || self.take()? != b'u' {
                            return Err("decode");
                        }
                        unit.extend_from_slice(b"\\u");
                        for _ in 0..4 {
                            unit.push(self.take()?);
                        }
                        let low = u16::from_str_radix(
                            std::str::from_utf8(&unit[8..]).map_err(|_| "decode")?,
                            16,
                        )
                        .map_err(|_| "decode")?;
                        if !(0xDC00..=0xDFFF).contains(&low) {
                            return Err("decode");
                        }
                    } else if (0xDC00..=0xDFFF).contains(&code) {
                        return Err("decode");
                    }
                } else if !b"\"\\/bfnrt".contains(&escape) {
                    return Err("malformed");
                }
            } else if b >= 128 {
                let len = match b {
                    0xC2..=0xDF => 2,
                    0xE0..=0xEF => 3,
                    0xF0..=0xF4 => 4,
                    _ => return Err("decode"),
                };
                for _ in 1..len {
                    unit.push(self.take()?);
                }
                std::str::from_utf8(&unit).map_err(|_| "decode")?;
            }
            if raw.len() + unit.len() <= cap && !clipped {
                raw.extend(unit);
            } else {
                clipped = true;
            }
        }
        if clipped && keep {
            self.clipped = true;
        }
        raw.push(b'"');
        let mut text = serde_json::from_slice::<String>(&raw).map_err(|_| "decode")?;
        self.left = self.left.saturating_sub(text.len());
        if clipped && keep {
            // Do not expose an incomplete short credential at a clipping boundary.
            if let Some(at) = text.rfind(char::is_whitespace) {
                if text.len() - at < 128 {
                    text.truncate(at);
                }
            }
            text.push_str("\n[content truncated]");
        }
        Ok(text)
    }
    fn value(&mut self, depth: usize, keep: bool) -> Result<Value, &'static str> {
        self.space()?;
        if depth > 64 {
            return Err("depth_limit");
        }
        let keep = keep && self.nodes > 0 && self.left > 0;
        if keep {
            self.nodes -= 1;
        } else {
            self.clipped = true;
        }
        match self.peek()?.ok_or("truncated_jsonl")? {
            b'"' => self.string(keep).map(Value::String),
            b'{' => {
                self.take()?;
                let mut map = Map::new();
                self.space()?;
                if self.peek()? == Some(b'}') {
                    self.take()?;
                    return Ok(Value::Object(map));
                }
                loop {
                    self.space()?;
                    let key = self.string(keep)?;
                    self.space()?;
                    if self.take()? != b':' {
                        return Err("malformed");
                    }
                    let value = self.value(depth + 1, keep)?;
                    if keep && map.len() < NODES {
                        map.insert(key, value);
                    }
                    self.space()?;
                    match self.take()? {
                        b'}' => break,
                        b',' => {}
                        _ => return Err("malformed"),
                    }
                }
                Ok(Value::Object(map))
            }
            b'[' => {
                self.take()?;
                let mut values = Vec::new();
                self.space()?;
                if self.peek()? == Some(b']') {
                    self.take()?;
                    return Ok(Value::Array(values));
                }
                loop {
                    let value = self.value(depth + 1, keep)?;
                    if keep && values.len() < NODES {
                        values.push(value);
                    }
                    self.space()?;
                    match self.take()? {
                        b']' => break,
                        b',' => {}
                        _ => return Err("malformed"),
                    }
                }
                Ok(Value::Array(values))
            }
            b't' | b'f' | b'n' => {
                let literal = match self.peek()?.unwrap() {
                    b't' => "true",
                    b'f' => "false",
                    _ => "null",
                };
                for b in literal.bytes() {
                    if self.take()? != b {
                        return Err("malformed");
                    }
                }
                Ok(match literal {
                    "true" => Value::Bool(true),
                    "false" => Value::Bool(false),
                    _ => Value::Null,
                })
            }
            b'-' | b'0'..=b'9' => {
                let mut token = Vec::new();
                while self
                    .peek()?
                    .is_some_and(|b| b"-+0123456789.eE".contains(&b))
                {
                    let b = self.take()?;
                    if token.len() < 128 {
                        token.push(b);
                    } else {
                        self.clipped = true;
                    }
                }
                serde_json::from_slice(&token).map_err(|_| "malformed")
            }
            _ => Err(if self.peek()?.is_some_and(|b| b >= 128) {
                "decode"
            } else {
                "malformed"
            }),
        }
    }
    pub fn row(&mut self) -> Result<Option<Row>, &'static str> {
        loop {
            self.space()?;
            if self.peek()? == Some(b'\n') {
                self.take()?;
            } else {
                break;
            }
        }
        if self.peek()?.is_none() {
            return Ok(None);
        }
        let start = self.offset;
        self.last_lf = false;
        self.left = ROW_BYTES;
        self.nodes = NODES;
        self.clipped = false;
        let value = self.value(0, true).and_then(|value| {
            self.space()?;
            if self.peek()?.is_none_or(|b| b == b'\n') {
                Ok(value)
            } else {
                Err("malformed")
            }
        });
        // A newline already consumed by a bad string belongs to this row.
        if !self.last_lf {
            loop {
                match self.peek()? {
                    None => break,
                    Some(b'\n') => {
                        self.take()?;
                        break;
                    }
                    _ => {
                        let buf = self.input.fill_buf().map_err(|_| "read")?;
                        let n = buf.iter().position(|b| *b == b'\n').unwrap_or(buf.len());
                        self.input.consume(n);
                        self.offset += n as u64;
                    }
                }
            }
        }
        Ok(Some((start, value, self.clipped)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bad_rows_do_not_stall_or_consume_the_next_row() {
        let data = b"{\"ok\":1}\nnot-json\n{\"bad\":\n{\"ok\":2}\n\xff\xfe\n{\"ok\":3}\n";
        let mut reader = Reader::new(std::io::Cursor::new(data));
        let mut valid = 0;
        let mut bad = 0;
        while let Some((_, row, _)) = reader.row().unwrap() {
            if row.is_ok() {
                valid += 1;
            } else {
                bad += 1;
            }
            assert!(valid + bad <= 6);
        }
        assert_eq!((valid, bad), (3, 3));
    }
    #[test]
    fn unicode_escapes_and_invalid_suffixes_are_validated_even_after_clipping() {
        let text = format!(
            "{{\"text\":\"{}\\uD83D\\uDE00\",\"after\":true}}\n",
            "x".repeat(STRING_BYTES + 1)
        );
        let mut reader = Reader::new(std::io::Cursor::new(text));
        let (_, row, clipped) = reader.row().unwrap().unwrap();
        let value = row.unwrap();
        assert!(clipped);
        assert_eq!(value["after"], true);
        assert!(value["text"].as_str().unwrap().len() < STRING_BYTES + 100);
        let mut bad = format!("{{\"text\":\"{}", "x".repeat(STRING_BYTES + 1)).into_bytes();
        bad.extend_from_slice(b"\xff\"}\n{\"after\":true}\n");
        let mut reader = Reader::new(std::io::Cursor::new(bad));
        assert!(reader.row().unwrap().unwrap().1.is_err());
        assert!(reader.row().unwrap().unwrap().1.is_ok());
    }
}
