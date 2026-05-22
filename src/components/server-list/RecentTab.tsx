import { RecentGamesList } from "./RecentGamesList";

export interface RecentTabProps {
  onSelectGame: (placeId: number, name?: string, iconUrl?: string | null) => void;
  maxRecent: number;
  userId: number | null;
}

export function RecentTab({ onSelectGame, maxRecent, userId }: RecentTabProps) {
  return <RecentGamesList userId={userId} maxRecent={maxRecent} onSelect={onSelectGame} />;
}
