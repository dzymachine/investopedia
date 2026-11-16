<task>
Restyle my investment dashboard (Charles Schwab, Robinhood, Kraken via Plaid) to feel clean, dark feminine and dark academia, with a magic feel like an old school of magic but no Harry Potter references. Dark, with sparkle animations and hover animations. Most cards are clickable and show more data. Add a "You should know this" section. The screen's one job: show me what I own, how it's doing, and what my taxes look like at a glance, with detail one click away.
</task>

<tech_stack>
Existing project at investment-dashboard. Vanilla HTML, CSS and ES-module JS in public/ (index.html, styles.css, app.js), served by Express (server.js). No framework, no build step. Keep the existing DOM helper h(), the /api/portfolio data shape from lib/portfolio.js, and the Plaid Link flow. Fonts load from Google Fonts. The wood texture is at public/img/dark-wood.jpg (Poly Haven dark_wood, CC0); serve it as a normal file, not base64. Desktop-first, also checked at 390px.
</tech_stack>

<visual_reference>
Match the approved style preview at design/style-preview.html. It sets the fonts, tokens, lamp lighting, panels, parchment, seals and component levels. Extend it to the whole dashboard; don't change its decisions.
</visual_reference>

<aesthetic_direction>
An old school library after hours: dark walnut, brass fittings, leather-bound panels, lamp and lantern light pooling on the desk, parchment notes sealed with oxblood wax. The money is set like a printed book of spells.
Spend the boldness on lamp light and the hero figures. Keep tables and labels quiet.
</aesthetic_direction>

<typography>
Display: IM Fell English (headings, hero figures, drop caps). Body and all numbers: EB Garamond, with lining tabular figures in tables. Labels: Cinzel, 11px, letterspaced uppercase.
Hero figures are at least 3x body size.
</typography>

<color_and_theme>
Use only the tokens from the preview: espresso #1C1510, shadow #0F0D0C, leather #2A1C14, walnut #4B3424, parchment #C8B08A, ink #2B1E16, aged paper text #D8C5AF, muted #A8957C, brass #B58A5A (small text #C9A56A), oxblood #5C1A22, bottle green #39463B (lamp glow #3F8A63), navy #2F4468, gain #8DB89B / #2F4A3A on parchment, loss #CF8C79 / #7A2A1C on parchment.
Brass dominates. Oxblood appears only on the Add account button and the wax seals. Gains and losses always carry a +/− sign and arrow, never color alone.
</color_and_theme>

<layout>
Header bar of dark walnut with brass hairline. Then the "You should know this" notes, then the four summary panels, allocation, holdings, taxes and tax lots. Lead with total value as the largest figure on the page, lit by a lamp pool.
</layout>

<components>
- Summary panels, account chips, holding rows and tax cards (Polished): brass-framed leather panels with rivets. Hover lifts 4px and brightens the brass frame. Click opens a parchment drawer from the right with the detail: per-account and per-term breakdown for totals; that holding's lots, accounts and tax status for a row; the lots behind a tax figure. Esc and backdrop close it; focus moves into the drawer and returns on close.
- You should know this (Polished): parchment notes with oxblood wax seals, ranked by urgency. Hover tilts the seal and makes it glow; click expands the numbers behind the note. Generate the notes from the portfolio data: lots turning long-term soon with the tax saved by waiting; positions over 20% of the portfolio; one institution holding most of the money; losses that could offset gains this year; accounts needing re-login; cash sitting idle; the filing deadline. Show only notes that apply.
- Allocation (Polished): stacked bars in a brass channel fill in on load; hover a segment for a parchment tooltip.
- Background (Advanced): the gold-dust and ember canvas from the preview, about 90 motes (45 when hardwareConcurrency ≤ 4), a few drawn toward the cursor. Pause when the tab is hidden; static with reduced motion. Animate only transform and opacity; keep 60fps.
- Tables (Polished): sortable holdings, row hover warms the row with lamp light, lots filter by term.
</components>

<motion>
On load, panels rise in with a 60ms stagger and the lamp pools fade up. Lantern glows flicker by ±3% opacity. Add account has hover, focus and pressed states. Everything respects prefers-reduced-motion.
</motion>

<background>
The walnut texture under dark gradient overlays, a near-black vignette at the edges, warm amber pools over the header and summary, one green banker's-lamp glow over allocation, and faint armillary line art in one corner.
</background>

<avoid>
- Any Harry Potter name, house, place, creature or symbol
- Bright cream, rose or pink, white text, saturated reds
- Procedural wood noise; glassmorphism; identical bento tiles
- Inter, Roboto, system-ui, Space Grotesk, Fraunces
- Emoji as icons; effects on every element
</avoid>

<quality_floor>
No horizontal page scroll at 390px; wide tables scroll inside their own container. Content visible at rest. Visible keyboard focus. Text at WCAG AA. Clickable panels are buttons or have role and keyboard support. Plain, specific copy in sentence case. Keep the existing tests passing.
</quality_floor>

<process>
Before writing code, state the direction, fonts and tokens in 3–4 lines. Build. Then look at it as a skeptical designer, find the most generic part, and change it.
</process>
