import { RecentGamesList } from "./RecentGamesList";

export interface RecentTabProps {
  onSelectGame: (placeId: number) => void;
  maxRecent: number;
  userId: number | null;
}

export function RecentTab({ onSelectGame, maxRecent, userId }: RecentTabProps) {
  return <RecentGamesList userId={userId} maxRecent={maxRecent} onSelect={onSelectGame} />;
}
