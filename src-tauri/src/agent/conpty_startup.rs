//! portable-pty enables INHERIT_CURSOR. Detached launches have no renderer to
//! answer ConPTY's initial query, so acknowledge the new screen's origin once.
//! Consume that query to avoid a second response when a desktop attaches.
pub(super) struct Cursor {
    active: bool,
    pending: Vec<u8>,
    seen: usize,
}
impl Cursor {
    pub fn new(detached: bool) -> Self {
        Self {
            active: detached,
            pending: Vec::new(),
            seen: 0,
        }
    }
    pub fn feed(&mut self, bytes: &[u8]) -> (bool, Vec<u8>) {
        if !self.active {
            return (false, bytes.to_vec());
        }
        const QUERY: &[u8] = b"\x1b[6n";
        self.seen += bytes.len();
        self.pending.extend_from_slice(bytes);
        if let Some(index) = self.pending.windows(QUERY.len()).position(|b| b == QUERY) {
            self.pending.drain(index..index + QUERY.len());
            self.active = false;
            return (true, std::mem::take(&mut self.pending));
        }
        // Only handle startup, never a later application's cursor query.
        if self.seen >= 8192 {
            self.active = false;
            return (false, std::mem::take(&mut self.pending));
        }
        let keep = (1..QUERY.len())
            .rev()
            .find(|n| self.pending.ends_with(&QUERY[..*n]))
            .unwrap_or(0);
        let output = self.pending.drain(..self.pending.len() - keep).collect();
        (false, output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detached_cursor_query_handles_every_split_and_answers_only_once() {
        let bytes = b"\x1b[?25l\x1b[6nhello\x1b[6n";
        for split in 0..=bytes.len() {
            let mut cursor = Cursor::new(true);
            let (a, mut output) = cursor.feed(&bytes[..split]);
            let (b, rest) = cursor.feed(&bytes[split..]);
            output.extend(rest);
            assert_eq!(u8::from(a) + u8::from(b), 1);
            assert_eq!(output, b"\x1b[?25lhello\x1b[6n");
            assert_eq!(cursor.feed(b"\x1b[6n"), (false, b"\x1b[6n".to_vec()));
        }
    }
    #[test]
    fn attached_and_nonstartup_output_remains_unchanged() {
        let mut attached = Cursor::new(false);
        assert_eq!(attached.feed(b"\x1b[6n"), (false, b"\x1b[6n".to_vec()));
        let mut cursor = Cursor::new(true);
        assert_eq!(
            cursor.feed("中文\x1b[".as_bytes()),
            (false, "中文".as_bytes().to_vec())
        );
        assert_eq!(cursor.feed(b"31m"), (false, b"\x1b[31m".to_vec()));
        let text = vec![b'x'; 8192];
        assert_eq!(cursor.feed(&text), (false, text));
        assert_eq!(cursor.feed(b"\x1b[6n"), (false, b"\x1b[6n".to_vec()));
    }
}
