#!/usr/bin/env bash

# Real Linux desktop clipboard E2E for the local Agent terminal.
#
# This intentionally uses Xvfb, a private D-Bus, isolated HOME/XDG paths, a
# real GTK X11 clipboard owner, and xdotool keyboard/mouse events. It does not
# attach to an existing display or application process. Run only after building
# the current debug desktop binary:
#
#   cargo build --manifest-path src-tauri/Cargo.toml
#   scripts/linux-clipboard-e2e.sh
#
# Set LATTICETERM_E2E_KEEP=1 to retain synthetic screenshots/logs on success.

set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
HELPER_DIR="$SCRIPT_DIR/linux-clipboard-e2e"
APP_BIN=${LATTICETERM_E2E_APP_BIN:-$REPO_ROOT/src-tauri/target/debug/lattice-term}
VITE_BIN="$REPO_ROOT/node_modules/.bin/vite"
NODE_BIN=$(command -v node || true)
KEEP_ARTIFACTS=${LATTICETERM_E2E_KEEP:-0}
DISPLAY_MIN=${LATTICETERM_E2E_DISPLAY_MIN:-90}
DISPLAY_MAX=${LATTICETERM_E2E_DISPLAY_MAX:-190}

E2E_ROOT=""
DISPLAY_ID=""
WINDOW_ID=""
WINDOW_X=0
WINDOW_Y=0
WINDOW_WIDTH=0
WINDOW_HEIGHT=0
Xvfb_PID=""
VITE_PID=""
APP_SESSION_PID=""
CLIPBOARD_OWNER_PID=""
FAKE_AGENT_PID=""
STAGED_IMAGE=""
TEST_SUCCEEDED=0

log() {
  printf '[linux-clipboard-e2e] %s\n' "$*"
}

die() {
  printf '[linux-clipboard-e2e] ERROR: %s\n' "$*" >&2
  return 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"
}

pid_has_nonce() {
  local pid=$1
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [[ -r "/proc/$pid/environ" ]] || return 1
  grep -zFqx "LATTICETERM_E2E_NONCE=$E2E_NONCE" \
    "/proc/$pid/environ" 2>/dev/null
}

terminate_exact_pid() {
  local label=$1
  local pid=${2:-}
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  if ! pid_has_nonce "$pid"; then
    log "refusing to stop $label PID $pid because its test nonce no longer matches"
    return 0
  fi
  log "stopping $label PID $pid"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      return 0
    fi
    if [[ $(ps -o stat= -p "$pid" 2>/dev/null) == Z* ]]; then
      wait "$pid" 2>/dev/null || true
      return 0
    fi
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

terminate_test_session() {
  local label=$1
  local leader=${2:-}
  [[ "$leader" =~ ^[0-9]+$ ]] || return 0
  kill -0 "$leader" 2>/dev/null || return 0
  if ! pid_has_nonce "$leader"; then
    log "refusing to stop $label session $leader because its test nonce no longer matches"
    return 0
  fi
  local sid
  sid=$(ps -o sid= -p "$leader" 2>/dev/null | tr -d '[:space:]')
  if [[ "$sid" != "$leader" ]]; then
    log "refusing group cleanup for $label: PID $leader is not its isolated session leader"
    terminate_exact_pid "$label" "$leader"
    return 0
  fi
  log "stopping isolated $label session $leader"
  kill -TERM -- "-$leader" 2>/dev/null || true
  for _ in $(seq 1 50); do
    kill -0 -- "-$leader" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL -- "-$leader" 2>/dev/null || true
  wait "$leader" 2>/dev/null || true
}

cleanup() {
  local original_status=$?
  set +e

  if [[ -z "$FAKE_AGENT_PID" && -n "$E2E_ROOT" && -r "$E2E_ROOT/fake-aider.pid" ]]; then
    read -r FAKE_AGENT_PID <"$E2E_ROOT/fake-aider.pid"
  fi
  terminate_exact_pid "fake aider" "$FAKE_AGENT_PID"
  terminate_exact_pid "GTK clipboard owner" "$CLIPBOARD_OWNER_PID"
  terminate_test_session "desktop app" "$APP_SESSION_PID"
  # portable-pty starts the CLI in its own session. Re-read after the desktop
  # has stopped so a launch racing with an early test failure cannot orphan it.
  if [[ -n "$E2E_ROOT" && -r "$E2E_ROOT/fake-aider.pid" ]]; then
    read -r FAKE_AGENT_PID <"$E2E_ROOT/fake-aider.pid"
    terminate_exact_pid "fake aider" "$FAKE_AGENT_PID"
  fi
  terminate_test_session "Vite" "$VITE_PID"
  terminate_exact_pid "Xvfb" "$Xvfb_PID"

  if [[ -n "$STAGED_IMAGE" && -e "$STAGED_IMAGE" ]]; then
    log "WARNING: staged image still exists after process cleanup: $STAGED_IMAGE"
  fi

  if [[ -n "$E2E_ROOT" && -d "$E2E_ROOT" ]]; then
    if [[ "$TEST_SUCCEEDED" == 1 && "$KEEP_ARTIFACTS" != 1 ]]; then
      case "$E2E_ROOT" in
        /tmp/latticeterm-clipboard-e2e.*)
          rm -rf -- "$E2E_ROOT"
          ;;
        *)
          log "refusing to remove unexpected artifact path: $E2E_ROOT"
          ;;
      esac
    else
      log "artifacts retained at $E2E_ROOT"
    fi
  fi

  trap - EXIT INT TERM
  exit "$original_status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_for_file() {
  local path=$1
  local seconds=$2
  local attempts=$((seconds * 10))
  for _ in $(seq 1 "$attempts"); do
    [[ -s "$path" ]] && return 0
    sleep 0.1
  done
  return 1
}

wait_for_log_text() {
  local path=$1
  local text=$2
  local seconds=$3
  local attempts=$((seconds * 10))
  for _ in $(seq 1 "$attempts"); do
    grep -aFq -- "$text" "$path" 2>/dev/null && return 0
    sleep 0.1
  done
  return 1
}

capture_window() {
  local path=$1
  timeout 5s env DISPLAY="$DISPLAY_ID" import -window "$WINDOW_ID" "$path"
}

refresh_window_geometry() {
  local geometry
  geometry=$(env DISPLAY="$DISPLAY_ID" xdotool getwindowgeometry --shell "$WINDOW_ID")
  WINDOW_X=$(sed -n 's/^X=//p' <<<"$geometry")
  WINDOW_Y=$(sed -n 's/^Y=//p' <<<"$geometry")
  WINDOW_WIDTH=$(sed -n 's/^WIDTH=//p' <<<"$geometry")
  WINDOW_HEIGHT=$(sed -n 's/^HEIGHT=//p' <<<"$geometry")
  [[ "$WINDOW_WIDTH" -ge 1000 && "$WINDOW_HEIGHT" -ge 700 ]] \
    || die "desktop window is unexpectedly small: ${WINDOW_WIDTH}x${WINDOW_HEIGHT}"
}

click_local() {
  local x=$1
  local y=$2
  refresh_window_geometry
  env DISPLAY="$DISPLAY_ID" xdotool mousemove "$((WINDOW_X + x))" "$((WINDOW_Y + y))" click 1
}

send_key() {
  local chord=$1
  env DISPLAY="$DISPLAY_ID" xdotool windowfocus "$WINDOW_ID" >/dev/null 2>&1 || true
  env DISPLAY="$DISPLAY_ID" xdotool key --window "$WINDOW_ID" --clearmodifiers "$chord"
}

focus_terminal() {
  click_local \
    "${LATTICETERM_E2E_TERMINAL_FOCUS_X:-850}" \
    "${LATTICETERM_E2E_TERMINAL_FOCUS_Y:-500}"
}

find_visible_text() {
  local screenshot=$1
  local needle=$2
  shift 2
  python3 "$HELPER_DIR/ocr_find.py" "$screenshot" "$needle" "$@"
}

wait_for_visible_text() {
  local needle=$1
  local stem=$2
  local seconds=$3
  shift 3
  local attempts=$((seconds * 2))
  local screenshot="$E2E_ROOT/${stem}.png"
  local result
  for _ in $(seq 1 "$attempts"); do
    capture_window "$screenshot"
    if result=$(find_visible_text "$screenshot" "$needle" "$@" 2>/dev/null); then
      printf '%s\n' "$result"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

stop_clipboard_owner() {
  terminate_exact_pid "GTK clipboard owner" "$CLIPBOARD_OWNER_PID"
  CLIPBOARD_OWNER_PID=""
}

start_clipboard_owner() {
  local mode=$1
  local value=$2
  stop_clipboard_owner
  : >"$E2E_ROOT/clipboard-owner.log"
  env -i "${E2E_ENV[@]}" \
    NO_AT_BRIDGE=1 \
    python3 "$HELPER_DIR/clipboard_fixture.py" "$mode" "$value" \
    >"$E2E_ROOT/clipboard-owner.log" 2>&1 &
  CLIPBOARD_OWNER_PID=$!
  if ! wait_for_log_text "$E2E_ROOT/clipboard-owner.log" "READY" 5; then
    die "GTK clipboard owner did not become ready"
  fi
  kill -0 "$CLIPBOARD_OWNER_PID" 2>/dev/null \
    || die "GTK clipboard owner exited after claiming the selection"
}

read_clipboard_text() {
  timeout 5s env -i "${E2E_ENV[@]}" \
    NO_AT_BRIDGE=1 \
    python3 "$HELPER_DIR/clipboard_fixture.py" read-text
}

for command in \
  Xvfb xdpyinfo xdotool dbus-run-session setsid curl import tesseract \
  python3 ps stat timeout; do
  require_command "$command"
done

[[ -x "$APP_BIN" ]] || die "desktop binary is missing or not executable: $APP_BIN"
[[ -x "$VITE_BIN" ]] || die "Vite is not installed: $VITE_BIN"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || die "Node.js is missing"
[[ -x "$HELPER_DIR/fake-aider.sh" ]] || die "fake aider fixture is not executable"
[[ -r "$HELPER_DIR/fake_aider.py" ]] || die "fake aider Python peer is missing"
[[ "$DISPLAY_MIN" =~ ^[0-9]+$ && "$DISPLAY_MAX" =~ ^[0-9]+$ ]] \
  || die "display bounds must be positive integers"
(( DISPLAY_MIN > 0 && DISPLAY_MAX >= DISPLAY_MIN )) \
  || die "display bounds must exclude the primary display and form a valid range"

NO_AT_BRIDGE=1 python3 - <<'PY'
import gi
from PIL import Image
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # noqa: F401
assert Image is not None
PY

umask 077
E2E_ROOT=$(mktemp -d /tmp/latticeterm-clipboard-e2e.XXXXXX)
mkdir -p \
  "$E2E_ROOT/home" \
  "$E2E_ROOT/data" \
  "$E2E_ROOT/config" \
  "$E2E_ROOT/cache" \
  "$E2E_ROOT/runtime" \
  "$E2E_ROOT/bin" \
  "$E2E_ROOT/tmp" \
  "$E2E_ROOT/work"
chmod 700 "$E2E_ROOT/runtime"
ln -s "$HELPER_DIR/fake-aider.sh" "$E2E_ROOT/bin/aider"
ln -s "$NODE_BIN" "$E2E_ROOT/bin/node"
: >"$E2E_ROOT/pty-input.log"
chmod 600 "$E2E_ROOT/pty-input.log"

E2E_NONCE="ltclip-$(date +%s)-$$-$RANDOM"
export E2E_NONCE
FIXTURE_IMAGE="$E2E_ROOT/clipboard-fixture.png"
python3 "$HELPER_DIR/clipboard_fixture.py" create-image "$FIXTURE_IMAGE"

log "artifacts: $E2E_ROOT"

for candidate in $(seq "$DISPLAY_MIN" "$DISPLAY_MAX"); do
  [[ -e "/tmp/.X${candidate}-lock" || -S "/tmp/.X11-unix/X${candidate}" ]] && continue
  : >"$E2E_ROOT/xvfb.log"
  env LATTICETERM_E2E_NONCE="$E2E_NONCE" \
    Xvfb ":$candidate" -screen 0 1440x960x24 -nolisten tcp -noreset \
    >"$E2E_ROOT/xvfb.log" 2>&1 &
  Xvfb_PID=$!
  sleep 0.2
  if kill -0 "$Xvfb_PID" 2>/dev/null \
    && env DISPLAY=":$candidate" xdpyinfo >/dev/null 2>&1; then
    DISPLAY_ID=":$candidate"
    break
  fi
  wait "$Xvfb_PID" 2>/dev/null || true
  Xvfb_PID=""
done
[[ -n "$DISPLAY_ID" ]] || die "could not reserve an isolated X display"
log "isolated display: $DISPLAY_ID (Xvfb PID $Xvfb_PID)"

SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
E2E_ENV=(
  "LATTICETERM_E2E_NONCE=$E2E_NONCE"
  "LATTICETERM_E2E_PTY_LOG=$E2E_ROOT/pty-input.log"
  "LATTICETERM_E2E_FAKE_PID_FILE=$E2E_ROOT/fake-aider.pid"
  "LATTICETERM_E2E_FAKE_OUTPUT_ACK=$E2E_ROOT/fake-aider-output.ack"
  "DISPLAY=$DISPLAY_ID"
  "GDK_BACKEND=x11"
  "GDK_SCALE=1"
  "GDK_DPI_SCALE=1"
  "XDG_SESSION_TYPE=x11"
  "HOME=$E2E_ROOT/home"
  "XDG_DATA_HOME=$E2E_ROOT/data"
  "XDG_CONFIG_HOME=$E2E_ROOT/config"
  "XDG_CACHE_HOME=$E2E_ROOT/cache"
  "XDG_RUNTIME_DIR=$E2E_ROOT/runtime"
  "TMPDIR=$E2E_ROOT/tmp"
  "PATH=$E2E_ROOT/bin:$SYSTEM_PATH"
  "SHELL=/bin/bash"
  "TERM=xterm-256color"
  "LANG=zh_TW.utf8"
  "LC_ALL=zh_TW.utf8"
  "NO_AT_BRIDGE=0"
  "GTK_USE_PORTAL=0"
  "GSETTINGS_BACKEND=memory"
  "WEBKIT_DISABLE_DMABUF_RENDERER=1"
  "LIBGL_ALWAYS_SOFTWARE=1"
)

# Start the frontend directly so its PID belongs to a dedicated, validated
# session. Vite's strict configured port makes an unrelated listener a hard
# failure instead of silently testing a different page.
setsid env -i "${E2E_ENV[@]}" \
  NO_AT_BRIDGE=1 \
  "$VITE_BIN" --host 127.0.0.1 >"$E2E_ROOT/vite.log" 2>&1 &
VITE_PID=$!
for _ in $(seq 1 100); do
  kill -0 "$VITE_PID" 2>/dev/null || die "Vite exited; inspect $E2E_ROOT/vite.log"
  if pid_has_nonce "$VITE_PID" \
    && grep -aFq 'Local:' "$E2E_ROOT/vite.log" \
    && curl --fail --silent --max-time 1 http://127.0.0.1:1420/ >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
kill -0 "$VITE_PID" 2>/dev/null || die "Vite exited before readiness verification"
pid_has_nonce "$VITE_PID" || die "the listener on port 1420 is not this test's Vite process"
grep -aFq 'Local:' "$E2E_ROOT/vite.log" || die "Vite never reported its own ready URL"
curl --fail --silent --max-time 1 http://127.0.0.1:1420/ >/dev/null \
  || die "Vite did not become ready"
log "isolated Vite session: $VITE_PID"

setsid env -i -C "$E2E_ROOT/work" "${E2E_ENV[@]}" \
  dbus-run-session -- "$APP_BIN" >"$E2E_ROOT/app.log" 2>&1 &
APP_SESSION_PID=$!

for _ in $(seq 1 200); do
  WINDOW_ID=$(env DISPLAY="$DISPLAY_ID" xdotool search --name '^LatticeTerm$' 2>/dev/null | tail -n 1 || true)
  [[ -n "$WINDOW_ID" ]] && break
  kill -0 "$APP_SESSION_PID" 2>/dev/null \
    || die "desktop app exited; inspect $E2E_ROOT/app.log"
  sleep 0.1
done
[[ -n "$WINDOW_ID" ]] || die "LatticeTerm window did not appear"
refresh_window_geometry
# GTK exposes the native window before WebKit has painted the React document.
# Waiting on a stable footer label prevents the first synthetic click from
# disappearing into that all-black startup frame.
wait_for_visible_text "LatticeTerm" "01-launched" 20 --min-x 800 --min-y 700 \
  >/dev/null || die "the WebKit frontend never finished its initial paint"
log "isolated desktop session: $APP_SESSION_PID, window $WINDOW_ID"

# Open the terminal workspace from the fixed desktop rail. The quick-chat list
# is intentionally used here: with only the fake aider in PATH, OCR can locate
# one real launch button without scrolling a long Agent Fleet page.
click_local \
  "${LATTICETERM_E2E_TERMINAL_NAV_X:-40}" \
  "${LATTICETERM_E2E_TERMINAL_NAV_Y:-139}"
AIDER_MATCH=$(wait_for_visible_text "Aider" "02-terminal-empty" 15 --min-x 250 --min-y 100 --scale 3) \
  || die "Aider quick-chat button was not visible"
read -r AIDER_X AIDER_Y _ <<<"$AIDER_MATCH"
click_local "$AIDER_X" "$AIDER_Y"
sleep 0.4
capture_window "$E2E_ROOT/02-after-aider-click.png"
send_key Escape
sleep 0.4
[[ ! -e "$E2E_ROOT/fake-aider.pid" ]] || die "Escape launched an Agent instead of cancelling"
capture_window "$E2E_ROOT/02-escape-cancelled.png"
send_key Return
sleep 0.4
capture_window "$E2E_ROOT/02-keyboard-reopened.png"
send_key Return
sleep 0.4
[[ ! -e "$E2E_ROOT/fake-aider.pid" ]] || die "the initially focused Cancel button launched an Agent"
capture_window "$E2E_ROOT/02-button-cancelled.png"
send_key Return
sleep 0.4
send_key Tab
send_key Return
send_key Return

wait_for_file "$E2E_ROOT/fake-aider.pid" 10 \
  || die "fake aider was not launched"
read -r FAKE_AGENT_PID <"$E2E_ROOT/fake-aider.pid"
pid_has_nonce "$FAKE_AGENT_PID" || die "fake aider PID is not owned by this test"
FAKE_AGENT_COUNT=0
for process in /proc/[0-9]*; do
  candidate=${process##*/}
  if pid_has_nonce "$candidate" && grep -zFq "$HELPER_DIR/fake_aider.py" "$process/cmdline" 2>/dev/null; then
    FAKE_AGENT_COUNT=$((FAKE_AGENT_COUNT + 1))
  fi
done
[[ "$FAKE_AGENT_COUNT" == 1 ]] || die "repeated confirmation created $FAKE_AGENT_COUNT fake Agents"
log "Escape / Cancel / keyboard focus return / repeated confirmation: PASS"
capture_window "$E2E_ROOT/03-terminal-ready.png"
log "fake aider PTY: $FAKE_AGENT_PID"

focus_terminal

TEXT_ONE="E2E_TEXT_CTRL_V_${E2E_NONCE//-/_}"
start_clipboard_owner serve-text "$TEXT_ONE"
send_key ctrl+v
wait_for_log_text "$E2E_ROOT/pty-input.log" "$TEXT_ONE" 5 \
  || die "Ctrl+V text did not reach the real PTY"
log "Ctrl+V text: PASS"
wait_for_log_text "$E2E_ROOT/fake-aider-output.ack" "COPY_TARGET_WRITTEN" 5 \
  || die "the fake CLI received Ctrl+V but did not write its PTY response"
[[ $(stat -c '%a' "$E2E_ROOT/fake-aider-output.ack") == 600 ]] \
  || die "fake CLI output acknowledgement is not mode 0600"
log "fake CLI PTY response write: PASS"

DSR_RESPONSE_PATTERN=$'\033\\[[0-9]+;[0-9]+R'
for _ in $(seq 1 50); do
  LC_ALL=C grep -aqE "$DSR_RESPONSE_PATTERN" "$E2E_ROOT/pty-input.log" \
    && break
  sleep 0.1
done
LC_ALL=C grep -aqE "$DSR_RESPONSE_PATTERN" "$E2E_ROOT/pty-input.log" \
  || die "the emitted PTY response never reached the xterm parser (no DSR reply)"
log "Tauri event -> frontend listener -> xterm parser: PASS"

# The first real paste is also a nonce-bound request for the fake CLI to emit
# a visible line over the same PTY. This avoids losing a startup banner before
# the frontend has subscribed to the Agent output stream.
if COPY_MATCH=$(wait_for_visible_text "E2ECOPYTARGET" "04-copy-target" 2 --min-x 300 --min-y 100); then
  read -r COPY_X COPY_Y _ <<<"$COPY_MATCH"
  log "post-mount PTY output OCR: PASS"
else
  # WebKitGTK's accelerated xterm canvas is not always composited into an X11
  # root-window screenshot under Xvfb. The DSR round trip above still proves
  # xterm parsed the line. Its fixed first row can therefore be selected by a
  # calibrated cell coordinate, with the actual clipboard text as the gate.
  COPY_X=${LATTICETERM_E2E_COPY_TARGET_X:-440}
  COPY_Y=${LATTICETERM_E2E_COPY_TARGET_Y:-246}
  log "xterm canvas absent from X11 screenshot; using calibrated first-row cell"
fi

TEXT_TWO="E2E_TEXT_CTRL_SHIFT_V_${E2E_NONCE//-/_}"
start_clipboard_owner serve-text "$TEXT_TWO"
send_key ctrl+shift+v
wait_for_log_text "$E2E_ROOT/pty-input.log" "$TEXT_TWO" 5 \
  || die "Ctrl+Shift+V text did not reach the real PTY"
log "Ctrl+Shift+V text: PASS"

# Select the synthetic output in the actual rendered xterm and prove both
# Linux copy shortcuts write the system clipboard.
refresh_window_geometry
env DISPLAY="$DISPLAY_ID" xdotool \
  mousemove "$((WINDOW_X + COPY_X))" "$((WINDOW_Y + COPY_Y))" \
  click --repeat 3 --delay 80 1
COPY_EXPECTED="E2ECOPYTARGET $E2E_NONCE"
COPY_SENTINEL_CTRL_C="E2E_COPY_SENTINEL_CTRL_C_${E2E_NONCE//-/_}"
start_clipboard_owner serve-text "$COPY_SENTINEL_CTRL_C"
send_key ctrl+c
sleep 0.3
COPIED=$(read_clipboard_text)
[[ "$COPIED" == "$COPY_EXPECTED" ]] \
  || die "Ctrl+C copied unexpected text: $COPIED"
COPY_SENTINEL_CTRL_SHIFT_C="E2E_COPY_SENTINEL_CTRL_SHIFT_C_${E2E_NONCE//-/_}"
start_clipboard_owner serve-text "$COPY_SENTINEL_CTRL_SHIFT_C"
send_key ctrl+shift+c
sleep 0.3
COPIED=$(read_clipboard_text)
[[ "$COPIED" == "$COPY_EXPECTED" ]] \
  || die "Ctrl+Shift+C copied unexpected text: $COPIED"
log "Ctrl+C / Ctrl+Shift+C selection copy: PASS"

# A click clears the selection. Ctrl+C must now remain a terminal interrupt.
focus_terminal
PTY_SIZE_BEFORE=$(stat -c '%s' "$E2E_ROOT/pty-input.log")
send_key ctrl+c
for _ in $(seq 1 50); do
  if tail -c "+$((PTY_SIZE_BEFORE + 1))" "$E2E_ROOT/pty-input.log" 2>/dev/null \
    | LC_ALL=C grep -q $'\003'; then
    break
  fi
  sleep 0.1
done
tail -c "+$((PTY_SIZE_BEFORE + 1))" "$E2E_ROOT/pty-input.log" \
  | LC_ALL=C grep -q $'\003' \
  || die "Ctrl+C without a selection did not reach the PTY as an interrupt"
log "Ctrl+C interrupt fall-through: PASS"

# Image paste uses a real X11 image owner. A normal key is sent immediately
# afterward as a UI/IPC heartbeat; the bounded wait catches a frozen main loop.
start_clipboard_owner serve-image "$FIXTURE_IMAGE"
focus_terminal
HEARTBEAT="E2E_HEARTBEAT_${E2E_NONCE//-/_}"
HEARTBEAT_STARTED=$(date +%s%3N)
send_key ctrl+v
env DISPLAY="$DISPLAY_ID" xdotool type --window "$WINDOW_ID" --delay 1 "$HEARTBEAT"
wait_for_log_text "$E2E_ROOT/pty-input.log" "$HEARTBEAT" 3 \
  || die "UI/IPC heartbeat stalled while the clipboard image was staged"
HEARTBEAT_FINISHED=$(date +%s%3N)
HEARTBEAT_MS=$((HEARTBEAT_FINISHED - HEARTBEAT_STARTED))
capture_window "$E2E_ROOT/05-image-heartbeat.png"
log "image-paste UI/IPC heartbeat: PASS (${HEARTBEAT_MS} ms)"

for _ in $(seq 1 200); do
  STAGED_IMAGE=$(grep -aoE "$E2E_ROOT/tmp/latticeterm-clip-[A-Za-z0-9._-]+\\.png" \
    "$E2E_ROOT/pty-input.log" 2>/dev/null | tail -n 1 || true)
  [[ -n "$STAGED_IMAGE" ]] && break
  sleep 0.1
done
[[ -n "$STAGED_IMAGE" ]] || die "image paste never delivered a staged PNG path"
python3 "$HELPER_DIR/clipboard_fixture.py" \
  verify-staged "$FIXTURE_IMAGE" "$STAGED_IMAGE" \
  | tee "$E2E_ROOT/staged-image-verification.txt"
log "real X11 image -> staged PNG: PASS"

# The right-most active-session header action is the direct disconnect button.
# It has no confirmation dialog; cleanup must happen as part of this operation,
# not only when the whole test app exits.
capture_window "$E2E_ROOT/06-before-disconnect.png"
refresh_window_geometry
click_local \
  "${LATTICETERM_E2E_SESSION_CLOSE_X:-$((WINDOW_WIDTH - 30))}" \
  "${LATTICETERM_E2E_SESSION_CLOSE_Y:-116}"
click_local \
  "${LATTICETERM_E2E_SESSION_CLOSE_X:-$((WINDOW_WIDTH - 30))}" \
  "${LATTICETERM_E2E_SESSION_CLOSE_Y:-116}"
for _ in $(seq 1 100); do
  [[ ! -e "$STAGED_IMAGE" ]] && break
  sleep 0.1
done
[[ ! -e "$STAGED_IMAGE" ]] \
  || die "staged PNG survived an explicit Agent disconnect: $STAGED_IMAGE"
for _ in $(seq 1 100); do
  pid_has_nonce "$FAKE_AGENT_PID" || break
  sleep 0.1
done
pid_has_nonce "$FAKE_AGENT_PID" \
  && die "fake aider survived an explicit Agent disconnect"
capture_window "$E2E_ROOT/07-after-disconnect.png"
log "disconnect removed PTY and staged PNG: PASS"

stop_clipboard_owner
TEST_SUCCEEDED=1
log "PASS: Linux text copy/paste and image paste completed through real X11 + WebKitGTK + PTY"
