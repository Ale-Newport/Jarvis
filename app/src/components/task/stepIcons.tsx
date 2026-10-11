import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CircleHelp,
  Clock,
  Compass,
  CornerDownLeft,
  Download,
  FileSearch,
  Keyboard,
  ListFilter,
  ListTodo,
  MousePointerClick,
  MoveVertical,
  Search,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import type { StepKind } from "../../api/types";

const ICONS: Record<StepKind, LucideIcon> = {
  navigate: Compass,
  search: Search,
  click: MousePointerClick,
  type: Keyboard,
  select: ListFilter,
  scroll: MoveVertical,
  read: BookOpen,
  extract: FileSearch,
  plan: ListTodo,
  wait: Clock,
  tab: AppWindow,
  download: Download,
  verify: ShieldCheck,
  confirm: CircleHelp,
  key: CornerDownLeft,
  back: ArrowLeft,
  forward: ArrowRight,
};

export function StepIcon({ kind, size = 14 }: { kind: StepKind; size?: number }) {
  const Icon = ICONS[kind] ?? Compass;
  return <Icon size={size} strokeWidth={1.9} />;
}
