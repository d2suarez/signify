# Teacher's Desk: colour standards for widgets

Teachers can give any tool any of the four theme colours (the palette's
`p1`–`p4`), and they can switch palettes whenever they like. A widget has to
look right in all of them. That means 4 colours × 5 palettes, plus a teacher's
own colour, in both light and dark mode. Nobody checks those combinations by
hand, so every widget follows the rules below, and
`test/colour-audit.browser.js` checks them.

## The two kinds of card

| `tone` | Default look | With a colour picked |
|---|---|---|
| `block` (timer, randomiser, groups…) | Filled with the family colour, everything in its ink | Filled with the picked colour instead |
| `card` (notes, alarms, Bible…) | White tile, colour only on the shape | Coloured frame; content on a **pale sheet** of the same colour (13% colour in the paper) |

The pale sheet works by redefining the paper tokens inside the card body:
`--surface`, `--card-bg`, `--desk`, `--bg`, `--line`, `--muted`, `--faint`.
Any widget that paints with those tokens gets the tint for free.

## Rules

1. **Paint with tokens, never literal colours.** Backgrounds use `--surface`
   (paper), `--desk` (a recessed well), `--bg`; borders `--line`; text `--ink`,
   `--muted`, `--faint`. A literal `#fff`, `white` or `#f3f2f2` stays white on
   a tinted sheet. That is how a widget ends up "white in the middle".
   *Exception:* a surface whose colour **is** the content, such as a Bible
   reading theme, the pupil's own seat colour or a highlighter pen. Those keep
   their fixed colours on purpose. Mark one that would fail the audit by
   design, such as the Colours tool's "black text on this colour" sample,
   with `data-audit="skip"`.

2. **Never paint the card's own colour inside the card.** Anything a widget
   colours with a palette hue inside the card (tiles, team colours, chips,
   bars) uses `--alt1`, `--alt2`, `--alt3` and their `-ink`s. These are the
   three palette colours that are *not* the card's colour. Every card and
   stage sets them, the picked colour wins over the family colour, and they
   survive the block reset. Group tiles cycle `--alt1..3` this way.
   Never use `--p1..--p4` directly inside a `block` card, because they are
   reset to the ink colour there.

3. **On a block, everything is the block's ink.** Text, borders and outlines
   use `currentColor` or `--role-ink`, and a selected control is the card
   colour and its ink swapped (`background: var(--role-ink); color: var(--role)`).
   Use a third colour only from `--alt*`.

4. **Text needs 3:1 contrast at the least** against whatever is directly
   behind it, in every colour and in dark mode. Grey text drawn for white
   (`--muted`, `--faint`) is pulled toward the ink on a sheet automatically.
   Don't hard-code a grey.

5. **A colour on a tint needs a dark partner.** Text on a `*-soft` background
   is the hue mixed into `--ink` (`color-mix(in srgb, var(--yellow) 35%, var(--ink))`),
   not the hue itself. Pale yellow on pale yellow can't be read.

6. **Fields stay the brightest thing on a sheet** (handled centrally), so it is
   obvious where to type. Don't give inputs their own background.

7. **Semantic colours stay semantic.** Green for right and points earned, and
   red for danger, are not palette colours and are allowed on any card.

## Checking a widget

Run the desk locally (`npm run dev`, or the `signify-desk-dev` launch
config), then load `test/colour-audit.browser.js` in the page and call it:

```js
const audit = /* paste the file's contents */;
await audit({ types: ['mywidget'], state: { classKey: '<a class key>' } });
```

It adds each tool in its usual colour and in `p1`–`p4`, and reports:

- `contrast` – text below 3:1 against what is behind it
- `vanishes` – a tile on a block painted the same colour as the card
- `white` – a plain white patch on a coloured working tool's sheet

Then it removes the tools again. Pass `state.classKey` so class tools draw
names and tiles rather than "choose a class". Run it again in dark mode
(Appearance → Dark). A new widget isn't done until the audit comes back
empty for it.

The audit only sees what is on screen. Open the widget's other screens
(settings, results, a made set of groups) and look at them in two or three
colours yourself.
