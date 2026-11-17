/**
 * Icon set.
 *
 * Visual defaults stay on a 16px grid with a 1.5px stroke and currentColor
 * so the interface keeps one weight. Most glyphs come from PulsoIcon (ISC)
 * via per-icon modules. Hover/focus still plays on desktop; taps, tab
 * selection, and status changes play once (≤600ms, never looping). The brand mark and
 * icons without a close semantic match remain in-house. Third-party notices
 * are in THIRD_PARTY_NOTICES.
 *
 * Emoji are never used as functional icons.
 */

import { createElement, useRef, type ComponentType, type ReactElement, type ReactNode, type SVGProps } from "react";
import {
  iconHoverEnabled,
  iconRuntimeEnabled,
  useIconAnimation,
  useIconPlayback,
  useIconPressPulse,
} from "./iconPulse";

export {
  ICON_PULSE_MS,
  iconHoverEnabled,
  iconMotionEnabled,
  iconPrefersReducedMotion,
  iconRuntimeEnabled,
  useIconPulse,
  useIconPulseWhen,
} from "./iconPulse";
import { Vault } from "pulsoicon-react/icons/vault";
import { ClipboardList } from "pulsoicon-react/icons/clipboard-list";
import { Bell } from "pulsoicon-react/icons/bell";
import { Settings } from "pulsoicon-react/icons/settings";
import { Search } from "pulsoicon-react/icons/search";
import { Plus } from "pulsoicon-react/icons/plus";
import { X } from "pulsoicon-react/icons/x";
import { ChevronDown } from "pulsoicon-react/icons/chevron-down";
import { ChevronRight } from "pulsoicon-react/icons/chevron-right";
import { Star } from "pulsoicon-react/icons/star";
import { PanelLeft } from "pulsoicon-react/icons/panel-left";
import { Pencil } from "pulsoicon-react/icons/pencil";
import { CopyPlus } from "pulsoicon-react/icons/copy-plus";
import { Trash } from "pulsoicon-react/icons/trash";
import { Sun } from "pulsoicon-react/icons/sun";
import { Moon } from "pulsoicon-react/icons/moon";
import { Shield } from "pulsoicon-react/icons/shield";
import { Lock } from "pulsoicon-react/icons/lock";
import { LockOpen } from "pulsoicon-react/icons/lock-open";
import { Key } from "pulsoicon-react/icons/key";
import { Terminal } from "pulsoicon-react/icons/terminal";
import { Sparkles } from "pulsoicon-react/icons/sparkles";
import { MessageSquare } from "pulsoicon-react/icons/message-square";
import { Send } from "pulsoicon-react/icons/send";
import { Mic } from "pulsoicon-react/icons/mic";
import { AudioLines } from "pulsoicon-react/icons/audio-lines";
import { Folder } from "pulsoicon-react/icons/folder";
import { FolderOpen } from "pulsoicon-react/icons/folder-open";
import { File } from "pulsoicon-react/icons/file";
import { FileCode } from "pulsoicon-react/icons/file-code";
import { FileImage } from "pulsoicon-react/icons/file-image";
import { FileArchive } from "pulsoicon-react/icons/file-archive";
import { FileText } from "pulsoicon-react/icons/file-text";
import { Link } from "pulsoicon-react/icons/link";
import { Monitor } from "pulsoicon-react/icons/monitor";
import { Check } from "pulsoicon-react/icons/check";
import { TriangleAlert } from "pulsoicon-react/icons/triangle-alert";
import { Play } from "pulsoicon-react/icons/play";
import { Tag } from "pulsoicon-react/icons/tag";
import { Info } from "pulsoicon-react/icons/info";
import { Waypoints } from "pulsoicon-react/icons/waypoints";
import { Keyboard } from "pulsoicon-react/icons/keyboard";
import { Download } from "pulsoicon-react/icons/download";
import { Upload } from "pulsoicon-react/icons/upload";
import { Ellipsis } from "pulsoicon-react/icons/ellipsis";
import { Copy } from "pulsoicon-react/icons/copy";
import { ScreenShare } from "pulsoicon-react/icons/screen-share";
import { Camera } from "pulsoicon-react/icons/camera";
import { CircleDot } from "pulsoicon-react/icons/circle-dot";
import { Square } from "pulsoicon-react/icons/square";
import { CornerDownRight } from "pulsoicon-react/icons/corner-down-right";
import { HardDrive } from "pulsoicon-react/icons/hard-drive";
import { Cpu } from "pulsoicon-react/icons/cpu";
import { Database } from "pulsoicon-react/icons/database";
import { RefreshCw } from "pulsoicon-react/icons/refresh-cw";
import { Globe } from "pulsoicon-react/icons/globe";
import { Palette } from "pulsoicon-react/icons/palette";
import { Clock } from "pulsoicon-react/icons/clock";
import { Vault as VaultData } from "pulsoicon-core/icons/vault";
import { ClipboardList as ClipboardListData } from "pulsoicon-core/icons/clipboard-list";
import { Bell as BellData } from "pulsoicon-core/icons/bell";
import { Settings as SettingsData } from "pulsoicon-core/icons/settings";
import { Search as SearchData } from "pulsoicon-core/icons/search";
import { Plus as PlusData } from "pulsoicon-core/icons/plus";
import { X as XData } from "pulsoicon-core/icons/x";
import { ChevronDown as ChevronDownData } from "pulsoicon-core/icons/chevron-down";
import { ChevronRight as ChevronRightData } from "pulsoicon-core/icons/chevron-right";
import { Star as StarData } from "pulsoicon-core/icons/star";
import { PanelLeft as PanelLeftData } from "pulsoicon-core/icons/panel-left";
import { Pencil as PencilData } from "pulsoicon-core/icons/pencil";
import { CopyPlus as CopyPlusData } from "pulsoicon-core/icons/copy-plus";
import { Trash as TrashData } from "pulsoicon-core/icons/trash";
import { Sun as SunData } from "pulsoicon-core/icons/sun";
import { Moon as MoonData } from "pulsoicon-core/icons/moon";
import { Shield as ShieldData } from "pulsoicon-core/icons/shield";
import { Lock as LockData } from "pulsoicon-core/icons/lock";
import { LockOpen as LockOpenData } from "pulsoicon-core/icons/lock-open";
import { Key as KeyData } from "pulsoicon-core/icons/key";
import { Terminal as TerminalData } from "pulsoicon-core/icons/terminal";
import { Sparkles as SparklesData } from "pulsoicon-core/icons/sparkles";
import { MessageSquare as MessageSquareData } from "pulsoicon-core/icons/message-square";
import { Send as SendData } from "pulsoicon-core/icons/send";
import { Mic as MicData } from "pulsoicon-core/icons/mic";
import { AudioLines as AudioLinesData } from "pulsoicon-core/icons/audio-lines";
import { Folder as FolderData } from "pulsoicon-core/icons/folder";
import { FolderOpen as FolderOpenData } from "pulsoicon-core/icons/folder-open";
import { File as FileData } from "pulsoicon-core/icons/file";
import { FileCode as FileCodeData } from "pulsoicon-core/icons/file-code";
import { FileImage as FileImageData } from "pulsoicon-core/icons/file-image";
import { FileArchive as FileArchiveData } from "pulsoicon-core/icons/file-archive";
import { FileText as FileTextData } from "pulsoicon-core/icons/file-text";
import { Link as LinkData } from "pulsoicon-core/icons/link";
import { Monitor as MonitorData } from "pulsoicon-core/icons/monitor";
import { Check as CheckData } from "pulsoicon-core/icons/check";
import { TriangleAlert as TriangleAlertData } from "pulsoicon-core/icons/triangle-alert";
import { Play as PlayData } from "pulsoicon-core/icons/play";
import { Tag as TagData } from "pulsoicon-core/icons/tag";
import { Info as InfoData } from "pulsoicon-core/icons/info";
import { Waypoints as WaypointsData } from "pulsoicon-core/icons/waypoints";
import { Keyboard as KeyboardData } from "pulsoicon-core/icons/keyboard";
import { Download as DownloadData } from "pulsoicon-core/icons/download";
import { Upload as UploadData } from "pulsoicon-core/icons/upload";
import { Ellipsis as EllipsisData } from "pulsoicon-core/icons/ellipsis";
import { Copy as CopyData } from "pulsoicon-core/icons/copy";
import { ScreenShare as ScreenShareData } from "pulsoicon-core/icons/screen-share";
import { Camera as CameraData } from "pulsoicon-core/icons/camera";
import { CircleDot as CircleDotData } from "pulsoicon-core/icons/circle-dot";
import { Square as SquareData } from "pulsoicon-core/icons/square";
import { CornerDownRight as CornerDownRightData } from "pulsoicon-core/icons/corner-down-right";
import { HardDrive as HardDriveData } from "pulsoicon-core/icons/hard-drive";
import { Cpu as CpuData } from "pulsoicon-core/icons/cpu";
import { Database as DatabaseData } from "pulsoicon-core/icons/database";
import { RefreshCw as RefreshCwData } from "pulsoicon-core/icons/refresh-cw";
import { Globe as GlobeData } from "pulsoicon-core/icons/globe";
import { Palette as PaletteData } from "pulsoicon-core/icons/palette";
import { Clock as ClockData } from "pulsoicon-core/icons/clock";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  size?: number;
  /** Truthy changes play the motion once. Use pulseOnMount to also play on first paint. */
  pulse?: number | string | boolean;
  /** When true, a truthy `pulse` also plays after the icon first mounts. */
  pulseOnMount?: boolean;
};

function Icon({
  size = 16,
  children,
  pulse: _pulse,
  pulseOnMount: _pulseOnMount,
  ...props
}: IconProps & { children?: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0, ...props.style }}
      {...props}
    >
      {children}
    </svg>
  );
}

type Glyph = (props: IconProps) => ReactElement;

type IconSpec = {
  nodes: ReadonlyArray<readonly [string, Record<string, unknown>, ...unknown[]]>;
};

function currentColor(props: IconProps): string {
  const { color, stroke } = props;
  if (typeof color === "string" && color) return color;
  if (typeof stroke === "string" && stroke) return stroke;
  return "currentColor";
}

function StaticPulso({
  spec,
  solid = false,
  ...props
}: IconProps & { spec: IconSpec; solid?: boolean }) {
  const { size = 16, strokeWidth, className, style, ref: _ref, focusable: _focusable, color: _color, stroke: _stroke, pulse: _pulse, pulseOnMount: _pulseOnMount, ...rest } = props;
  const strokeColor = currentColor(props);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={solid ? strokeColor : "none"}
      stroke={strokeColor}
      strokeWidth={strokeWidth ?? 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{ flexShrink: 0, overflow: "visible", ...style }}
      {...rest}
    >
      {spec.nodes.map(([tag, attrs], index) => createElement(tag, { key: index, ...attrs }))}
    </svg>
  );
}

function pulsoIconProps(props: IconProps, extras: { solid?: boolean } = {}) {
  const {
    size = 16,
    strokeWidth,
    className,
    style,
    focusable: _focusable,
    ref: _ref,
    pulse: _pulse,
    pulseOnMount: _pulseOnMount,
    ...rest
  } = props;
  return {
    ...rest,
    size,
    color: currentColor(props),
    strokeWidth: strokeWidth ?? 1.5,
    className,
    style: { flexShrink: 0, overflow: "visible" as const, ...style },
    "aria-hidden": true as const,
    focusable: false as const,
    ...extras,
  };
}

type PulseHandle = { startAnimation?: () => void; stopAnimation?: () => void };

function PulsoGlyph({
  MotionComp,
  spec,
  solid,
  ...props
}: IconProps & {
  MotionComp: ComponentType<Record<string, unknown>>;
  spec: IconSpec;
  solid?: boolean;
}) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const handleRef = useRef<PulseHandle | null>(null);
  const runtime = iconRuntimeEnabled();
  const hover = iconHoverEnabled();
  const press = useIconPressPulse(wrapRef, runtime && !hover);
  const playback = useIconPlayback(props.pulse, {
    enabled: runtime,
    pulseOnMount: props.pulseOnMount,
  });
  useIconAnimation(handleRef, press + playback, runtime);

  if (!runtime) {
    return <StaticPulso spec={spec} solid={solid} {...props} />;
  }

  return (
    <span ref={wrapRef} data-icon="" style={{ display: "contents" }}>
      <MotionComp
        {...pulsoIconProps(props, { solid })}
        ref={handleRef}
        autoAnimated={hover}
      />
    </span>
  );
}

function pulso(MotionComp: ComponentType<Record<string, unknown>>, spec: IconSpec, defaults?: { solid?: boolean }): Glyph {
  const GlyphIcon = (props: IconProps) => (
    <PulsoGlyph MotionComp={MotionComp} spec={spec} solid={defaults?.solid} {...props} />
  );
  return GlyphIcon;
}

export const LatticeMark = ({ size = 20, pulse: _pulse, pulseOnMount: _pulseOnMount, ...props }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
    focusable="false"
    {...props}
  >
    <path
      d="M6 6L18 18M18 6L6 18"
      stroke="currentColor"
      strokeOpacity="0.45"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <rect
      x="6"
      y="6"
      width="12"
      height="12"
      rx="2"
      stroke="currentColor"
      strokeWidth="1.5"
    />
    <circle cx="6" cy="6" r="1.75" fill="currentColor" />
    <circle cx="18" cy="6" r="1.75" fill="currentColor" />
    <circle cx="6" cy="18" r="1.75" fill="currentColor" />
    <circle cx="18" cy="18" r="1.75" fill="currentColor" />
    <circle cx="12" cy="12" r="2" fill="currentColor" />
  </svg>
);

/** Unique stacked host-card glyph; PulsoIcon has no close match. */
export const ConnectionsIcon: Glyph = (props) => (
  <Icon {...props}>
    <rect x="2" y="2.5" width="12" height="4.25" rx="1.25" />
    <rect x="2" y="9.25" width="12" height="4.25" rx="1.25" />
    <circle cx="4.5" cy="4.62" r=".75" fill="currentColor" />
    <circle cx="4.5" cy="11.38" r=".75" fill="currentColor" />
    <path d="M8 6.75v2.5" />
  </Icon>
);

/** Unique tunnel-arch glyph; PulsoIcon has no close match. */
export const TunnelIcon: Glyph = (props) => (
  <Icon {...props}>
    <path d="M2.5 13.5V6a5.5 5.5 0 0 1 11 0v7.5" />
    <path d="M5.5 13.5V7a2.5 2.5 0 0 1 5 0v6.5" />
    <path d="M8 13.5v-3.5" />
  </Icon>
);

export const VaultIcon = pulso(Vault, VaultData);
export const ActivityIcon = pulso(ClipboardList, ClipboardListData);
export const BellIcon = pulso(Bell, BellData);
export const SettingsIcon = pulso(Settings, SettingsData);
export const SearchIcon = pulso(Search, SearchData);
export const PlusIcon = pulso(Plus, PlusData);
export const CloseIcon = pulso(X, XData);
export const ChevronDownIcon = pulso(ChevronDown, ChevronDownData);
export const ChevronRightIcon = pulso(ChevronRight, ChevronRightData);

export const StarIcon = ({
  filled = false,
  ...props
}: IconProps & { filled?: boolean }) => (
  <PulsoGlyph MotionComp={Star as ComponentType<Record<string, unknown>>} spec={StarData} solid={filled} {...props} />
);

export const SidebarIcon = pulso(PanelLeft, PanelLeftData);
export const EditIcon = pulso(Pencil, PencilData);
export const DuplicateIcon = pulso(CopyPlus, CopyPlusData);
export const TrashIcon = pulso(Trash, TrashData);
export const SunIcon = pulso(Sun, SunData);
export const MoonIcon = pulso(Moon, MoonData);
export const ShieldIcon = pulso(Shield, ShieldData);
export const LockIcon = pulso(Lock, LockData);
export const UnlockIcon = pulso(LockOpen, LockOpenData);
export const KeyIcon = pulso(Key, KeyData);
export const TerminalIcon = pulso(Terminal, TerminalData);
export const AgentIcon = pulso(Sparkles, SparklesData);
export const ChatIcon = pulso(MessageSquare, MessageSquareData);
export const SendIcon = pulso(Send, SendData);
export const MicIcon = pulso(Mic, MicData);
export const WaveformIcon = pulso(AudioLines, AudioLinesData);
export const FolderIcon = pulso(Folder, FolderData);
export const FolderOpenIcon = pulso(FolderOpen, FolderOpenData);
export const FileIcon = pulso(File, FileData);
export const CodeFileIcon = pulso(FileCode, FileCodeData);
export const ImageFileIcon = pulso(FileImage, FileImageData);
export const ArchiveFileIcon = pulso(FileArchive, FileArchiveData);
export const DocumentFileIcon = pulso(FileText, FileTextData);
export const LinkFileIcon = pulso(Link, LinkData);
export const DesktopIcon = pulso(Monitor, MonitorData);
export const CheckIcon = pulso(Check, CheckData);
export const AlertIcon = pulso(TriangleAlert, TriangleAlertData);
export const PlayIcon = pulso(Play, PlayData);
export const TagIcon = pulso(Tag, TagData);
export const InfoIcon = pulso(Info, InfoData);
export const RoadmapIcon = pulso(Waypoints, WaypointsData);
export const KeyboardIcon = pulso(Keyboard, KeyboardData);
export const ImportIcon = pulso(Download, DownloadData);
export const ExportIcon = pulso(Upload, UploadData);
export const MoreIcon = pulso(Ellipsis, EllipsisData);
export const CopyIcon = pulso(Copy, CopyData);
export const ScreenShareIcon = pulso(ScreenShare, ScreenShareData);
export const CameraIcon = pulso(Camera, CameraData);
export const RecordIcon = pulso(CircleDot, CircleDotData);
export const StopIcon = pulso(Square, SquareData, { solid: true });
export const TransferIcon = pulso(CornerDownRight, CornerDownRightData);

/** RAM module glyph; MemoryStick is a USB stick and is not a match. */
export const MemoryIcon: Glyph = (props) => (
  <Icon {...props}>
    <rect x="1.75" y="4.75" width="12.5" height="6.5" rx="1.25" />
    <path d="M4.75 7.25v1.5M8 7.25v1.5M11.25 7.25v1.5" />
  </Icon>
);

export const DiskIcon = pulso(HardDrive, HardDriveData);
export const CpuIcon = pulso(Cpu, CpuData);
export const DatabaseIcon = pulso(Database, DatabaseData);
export const RefreshIcon = pulso(RefreshCw, RefreshCwData);
export const GlobeIcon = pulso(Globe, GlobeData);
export const PaletteIcon = pulso(Palette, PaletteData);
export const ClockIcon = pulso(Clock, ClockData);
