import { memo } from "react";
import type { Card } from "../../api/types";
import { FilesCard } from "./FilesCard";
import { ImagesCard } from "./ImagesCard";
import { LinksCard } from "./LinksCard";
import { SourcesCard } from "./SourcesCard";
import { TableCard } from "./TableCard";

function renderCard(card: Card, i: number) {
  switch (card.type) {
    case "links":
      return <LinksCard key={i} card={card} />;
    case "images":
      return <ImagesCard key={i} card={card} />;
    case "table":
      return <TableCard key={i} card={card} />;
    case "files":
      return <FilesCard key={i} card={card} />;
    case "sources":
      return <SourcesCard key={i} card={card} />;
    default:
      return null; // unknown card types from a newer backend are skipped
  }
}

export const CardList = memo(function CardList({ cards }: { cards: Card[] }) {
  return <>{cards.map(renderCard)}</>;
});
