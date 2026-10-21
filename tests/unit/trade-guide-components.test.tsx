import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import AuctionTimeline from "@/components/trade-guide/AuctionTimeline";
import Breadcrumb from "@/components/trade-guide/Breadcrumb";
import BoardTabsMock from "@/components/trade-guide/BoardTabsMock";
import CardTile from "@/components/trade-guide/CardTile";
import CrossChannelFigure from "@/components/trade-guide/CrossChannelFigure";
import ExchangeFigure from "@/components/trade-guide/ExchangeFigure";
import FaqAccordion from "@/components/trade-guide/FaqAccordion";
import FlowSteps from "@/components/trade-guide/FlowSteps";
import GuideIcon, { GUIDE_ICON_NAMES } from "@/components/trade-guide/GuideIcon";
import IconTile from "@/components/trade-guide/IconTile";
import ModeCard from "@/components/trade-guide/ModeCard";
import PhaseChips, { PHASE_CHIP_CLASS } from "@/components/trade-guide/PhaseChips";
import RuleList from "@/components/trade-guide/RuleList";
import TradeSettingsMock from "@/components/trade-guide/TradeSettingsMock";
import VisibilityTable from "@/components/trade-guide/VisibilityTable";
import WantableCheckMock from "@/components/trade-guide/WantableCheckMock";

/**
 * The diagram components of /guide/trade are pure presentation: every string arrives as
 * a prop (the page resolves ja/en messages and the code constants), so these tests feed
 * them sample strings and check structure and accessibility, not wording. Wording and
 * ja/en key coverage are checked by trade-guide-page.test.tsx against the real catalogs.
 */
afterEach(cleanup);

describe("GuideIcon", () => {
  it("renders every icon as a decorative, non-focusable SVG", () => {
    expect(GUIDE_ICON_NAMES.length).toBeGreaterThan(25);
    for (const name of GUIDE_ICON_NAMES) {
      const { container } = render(<GuideIcon name={name} />);
      const svg = container.querySelector("svg")!;
      expect(svg, name).not.toBeNull();
      expect(svg.getAttribute("aria-hidden"), name).toBe("true");
      expect(svg.getAttribute("focusable"), name).toBe("false");
      // Each glyph actually draws something (guards an empty path set).
      expect(svg.children.length, name).toBeGreaterThan(0);
      cleanup();
    }
  });
});

describe("ExchangeFigure", () => {
  it("is a figure whose caption states the swap in words, with both sides labelled", () => {
    const { container } = render(
      <ExchangeFigure
        giveLabel="You give"
        giveCount="Always 1"
        wantLabel="You want"
        wantCount="1 to 10"
        wantBadge="×3"
        arrowLabel="Swap"
        caption="You give one card and get three."
      />,
    );
    const figure = container.querySelector("figure")!;
    expect(figure.querySelector("figcaption")!.textContent).toBe("You give one card and get three.");
    for (const text of ["You give", "Always 1", "You want", "1 to 10", "×3", "Swap"]) {
      expect(figure.textContent).toContain(text);
    }
    // The double arrow is announced as text, not left to an unlabeled graphic.
    expect(figure.querySelector(".sr-only")!.textContent).toBe("Swap");
  });
});

describe("CardTile", () => {
  it("labels its role in text so the colour is not the only signal", () => {
    const { container } = render(<CardTile tone="give" label="You give" badge="×1" />);
    expect(container.textContent).toContain("You give");
    // The card art itself is decorative.
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it("omits the label pill when no label is given (cross-channel mini tiles)", () => {
    const { container } = render(<CardTile tone="want" label="" small />);
    expect(container.querySelector("p")).toBeNull();
  });
});

describe("FlowSteps", () => {
  const steps = [
    { icon: "tag", title: "List", description: "Create the listing." },
    { icon: "user", title: "Accept", description: "Someone accepts." },
    { icon: "check", title: "Done", description: "Swapped." },
  ] as const;

  it("is an ordered list numbered from the array order, with an arrow after every step but the last", () => {
    const { container } = render(<FlowSteps steps={steps} />);
    const list = container.querySelector("ol")!;
    const items = [...list.children];
    expect(items.map((li) => li.querySelector("span.rounded-full")!.textContent)).toEqual(["1", "2", "3"]);
    expect(items.map((li) => li.querySelectorAll('span[aria-hidden="true"]').length > 0)).toEqual([
      true,
      true,
      false,
    ]);
    // 3 steps side by side from md up (and stacked below md, which has no grid class).
    expect(list.className).toContain("md:grid-cols-3");
  });

  it("stays vertical in the column layout", () => {
    const { container } = render(<FlowSteps steps={steps.slice(0, 2)} layout="column" accent="sky" />);
    expect(container.querySelector("ol")!.className).not.toContain("md:grid");
  });
});

describe("AuctionTimeline", () => {
  const props = {
    biddingChip: "Taking bids",
    biddingTitle: "Bids come in",
    biddingDescription: "Pick a duration.",
    durationLabels: ["24 hours", "3 days", "7 days"],
    deadlineLabel: "Deadline",
    selectingChip: "Awaiting selection",
    selectingTitle: "Seller picks",
    selectingDescription: "One bid is chosen.",
    maxHoursLabel: "Up to 72 hours",
    outcomeLabel: "Two endings",
    completedChip: "Completed",
    completedDescription: "Cards swap.",
    expiredChip: "No deal",
    expiredDescription: "Cards are released.",
    noBidsNote: "No bids: ends at the deadline.",
    caption: "Bids, deadline, selection, then completed or no deal.",
  };

  it("lays the phases out as one list (no stray non-<li> children) with a text caption", () => {
    const { container } = render(<AuctionTimeline {...props} />);
    const list = container.querySelector("figure > ol")!;
    // bidding, deadline, selecting, outcomes: arrows live inside the items, not between them
    expect([...list.children].map((el) => el.tagName)).toEqual(["LI", "LI", "LI", "LI"]);
    expect(container.querySelector("figcaption")!.textContent).toBe(props.caption);
    expect(container.textContent).toContain(props.noBidsNote);
  });

  it("shows the three durations in order and uses the real status chip classes", () => {
    const { container } = render(<AuctionTimeline {...props} />);
    const durations = [...container.querySelectorAll("figure > ol > li:first-child ul li")].map((li) => li.textContent);
    expect(durations).toEqual(props.durationLabels);
    const chips = [...container.querySelectorAll("span.rounded.px-2")];
    const byText = (text: string) => chips.find((chip) => chip.textContent === text)!;
    expect(byText("Taking bids").className).toContain(PHASE_CHIP_CLASS.bidding);
    expect(byText("Awaiting selection").className).toContain(PHASE_CHIP_CLASS.selecting);
    expect(byText("Completed").className).toContain(PHASE_CHIP_CLASS.completed);
    expect(byText("No deal").className).toContain(PHASE_CHIP_CLASS.expired);
  });
});

describe("CrossChannelFigure", () => {
  it("names both channels and states the both-must-allow condition in a figcaption", () => {
    const { container } = render(
      <CrossChannelFigure
        inChannelTab="In-channel"
        inChannelCaption="Same channel"
        crossTab="Cross-channel"
        crossCaption="Other streamer"
        streamerA="Streamer A"
        streamerB="Streamer B"
        sideA="You give A's card"
        sideB="You ask for B's card"
        condition="Both streamers must allow it"
      />,
    );
    expect(container.querySelector("figcaption")!.textContent).toContain("Both streamers must allow it");
    for (const text of ["In-channel", "Cross-channel", "Streamer A", "Streamer B", "You give A's card"]) {
      expect(container.textContent).toContain(text);
    }
  });
});

describe("IconTile / ModeCard / RuleList / PhaseChips", () => {
  it("renders a tile with the requested heading level", () => {
    const { container } = render(<IconTile as="h3" icon="lock" title="Locked" description="Cannot reuse." />);
    expect(container.querySelector("h3")!.textContent).toBe("Locked");
    cleanup();
    const { container: other } = render(<IconTile icon="lock" title="Locked" description="Cannot reuse." />);
    expect(other.querySelector("h4")).not.toBeNull();
  });

  it("makes the whole mode card one link to its section, with the chips as a list", () => {
    const { container } = render(
      <ModeCard href="#offer" icon="swap" tone="offer" title="Regular" tagline="Swap now" chips={["A", "B"]} />,
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("#offer");
    expect([...link.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["A", "B"]);
  });

  it("lists rules one per item and marks prohibitions differently from facts", () => {
    const { container } = render(
      <RuleList
        items={[
          { key: "a", icon: "cards", text: "Fact" },
          { key: "b", icon: "ban", text: "Not allowed", kind: "ban" },
        ]}
      />,
    );
    const items = [...container.querySelectorAll("li")];
    expect(items.map((li) => li.textContent)).toEqual(["Fact", "Not allowed"]);
    expect(items[0].querySelector("span")!.className).toContain("purple");
    expect(items[1].querySelector("span")!.className).toContain("rose");
  });

  it("shows each status chip with the board's colour classes and its meaning", () => {
    const { container } = render(
      <PhaseChips
        items={[
          { key: "bidding", label: "Taking bids", description: "Open." },
          { key: "unsettleable", label: "Bid can't be completed", description: "Stuck." },
        ]}
      />,
    );
    const chips = [...container.querySelectorAll("li > span:first-child")];
    expect(chips[0].className).toContain("bg-emerald-700 text-emerald-50");
    expect(chips[1].className).toContain("bg-yellow-700 text-yellow-50");
    expect(container.textContent).toContain("Stuck.");
  });
});

describe("settings mock-ups", () => {
  const settings = {
    title: "Card Trading Settings",
    statusEnabled: "Allowed",
    statusDisabled: "Off",
    tradeEnabledLabel: "Allow trading",
    tradeEnabledHelp: "Viewers can trade.",
    crossLabel: "Allow cross-channel",
    crossHelp: "Partner must allow it too.",
    requiresTradeEnabled: "Turn trading on first",
    stateOn: "ON",
    stateOff: "OFF",
    caption: "Panel",
  };

  it("draws the ON panel with both switches on and spells the state out in text", () => {
    const { container } = render(<TradeSettingsMock {...settings} tradeEnabled crossEnabled />);
    expect(container.querySelector("figcaption")!.textContent).toBe("Panel");
    expect(container.textContent).toContain("Allowed");
    expect(container.textContent).not.toContain("Turn trading on first");
    expect(container.textContent!.match(/ON/g)).toHaveLength(2);
    // Switch tracks are decorative: the ON/OFF text carries the state.
    for (const track of container.querySelectorAll('span[aria-hidden="true"]')) {
      expect(track.className).toContain("relative");
    }
  });

  it("draws the OFF panel with the cross switch dimmed and the reason shown", () => {
    const { container } = render(<TradeSettingsMock {...settings} tradeEnabled={false} crossEnabled />);
    expect(container.textContent).toContain("Off");
    expect(container.textContent).toContain("Turn trading on first");
    // Both switches read OFF even though the stored cross setting is on: it cannot take effect.
    expect(container.textContent!.match(/OFF/g)).toHaveLength(2);
    expect(container.querySelectorAll(".opacity-50")).toHaveLength(1);
  });

  it("shows the card-edit checkbox both checked and unchecked, each with an icon and words", () => {
    const { container } = render(
      <WantableCheckMock label="Can be requested" checkedCaption="Requestable" uncheckedCaption="Not requestable" />,
    );
    expect(container.textContent!.match(/Can be requested/g)).toHaveLength(2);
    expect(container.textContent).toContain("Requestable");
    expect(container.textContent).toContain("Not requestable");
    // No real form control: the page has nothing that looks clickable but does nothing.
    expect(container.querySelector("input")).toBeNull();
  });

  it("renders the breadcrumb as a labelled ordered list with a separator between steps", () => {
    const { container } = render(<Breadcrumb label="Where" items={["User Settings", "Streamer", "Trading"]} />);
    expect(container.querySelector("nav")!.getAttribute("aria-label")).toBe("Where");
    const items = [...container.querySelectorAll("ol > li")];
    expect(items.map((li) => li.textContent)).toEqual(["User Settings", "Streamer", "Trading"]);
    expect(container.querySelectorAll("ol svg")).toHaveLength(2);
  });

  it("mirrors the board chrome: trade button, tabs (first active) and My trades link", () => {
    const { container } = render(
      <BoardTabsMock label="Board" tradeButton="Trade" tabs={["In-channel", "Cross-channel", "Auctions"]} myTradesLink="My trades" />,
    );
    const tabs = [...container.querySelectorAll("ul > li")];
    expect(tabs.map((li) => li.textContent)).toEqual(["In-channel", "Cross-channel", "Auctions"]);
    expect(tabs[0].className).toContain("bg-purple-600");
    expect(tabs[1].className).toContain("bg-gray-800");
    expect(container.querySelector('[role="group"]')!.getAttribute("aria-label")).toBe("Board");
  });
});

describe("VisibilityTable", () => {
  const rows = [
    { key: "names", aspect: "Names", revealed: { ok: true, text: "Visible" }, hidden: { ok: false, text: "Hidden" } },
    { key: "wanted", aspect: "Wanted", revealed: { ok: true, text: "Any card" }, hidden: { ok: false, text: "Owned only" } },
  ];

  it("is a real table with a caption, column and row headers", () => {
    const { container } = render(
      <VisibilityTable caption="Visibility" aspectHeader="Viewer sees" revealedHeader="Revealed" hiddenHeader="Hidden" rows={rows} />,
    );
    expect(container.querySelector("caption")!.textContent).toBe("Visibility");
    expect([...container.querySelectorAll("thead th")].map((th) => th.getAttribute("scope"))).toEqual(["col", "col", "col"]);
    expect([...container.querySelectorAll("tbody th")].map((th) => th.textContent)).toEqual(["Names", "Wanted"]);
  });

  it("gives every cell a check or cross icon AND text, so no cell relies on colour", () => {
    const { container } = render(
      <VisibilityTable caption="Visibility" aspectHeader="Viewer sees" revealedHeader="Revealed" hiddenHeader="Hidden" rows={rows} />,
    );
    const cells = [...container.querySelectorAll("tbody td")];
    expect(cells).toHaveLength(4);
    for (const cell of cells) {
      expect(cell.querySelector("svg")).not.toBeNull();
      expect((cell.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
    // ok cells are green, not-ok cells are red (and differ in icon, not just colour)
    expect(cells[0].querySelector("span span")!.className).toContain("emerald");
    expect(cells[1].querySelector("span span")!.className).toContain("rose");
    expect(cells[0].querySelector("path")!.getAttribute("d")).not.toBe(cells[1].querySelector("path")!.getAttribute("d"));
  });
});

describe("FaqAccordion", () => {
  it("renders one closed native <details> per entry, with the answer inside", () => {
    const { container } = render(
      <FaqAccordion
        items={[
          { key: "a", icon: "toggle", question: "Why A?", answer: "Because A." },
          { key: "b", icon: "ban", question: "Why B?", answer: "Because B." },
        ]}
      />,
    );
    const details = [...container.querySelectorAll("details")];
    expect(details).toHaveLength(2);
    expect(details.every((entry) => !entry.hasAttribute("open"))).toBe(true);
    expect(details[0].querySelector("summary")!.textContent).toBe("Why A?");
    expect(details[0].querySelector("p")!.textContent).toBe("Because A.");
  });
});
