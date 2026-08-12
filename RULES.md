# WatchBack Reporting Rules — the master file

**This file is the contract for everything WatchBack reports** — app reads, Slack briefs,
weekly reports. Marin reviews and edits *this file*; code and prompts implement it.

**The process rule that keeps quality from decaying** (established 12 Aug 2026, after the
quality plateau post-mortem):

> Every founder correction becomes THREE things in the same commit:
> 1. a rule in this file,
> 2. a regression test (`backend/test/`, runs on every push via GitHub Actions),
> 3. an enforcement: a deterministic gate/scrubber if mechanically checkable
>    (`backend/src/rulecheck.js`, `claims.js`, `adsguard.js`), or a prompt rule + the
>    nightly QA judge (`backend/src/qa.js`) if it needs judgment.
>
> A correction that only lands in a prompt is NOT a fix — prompt-only rules decay.

Classes: **ENFORCED** = deterministic code · **PROMPT** = AI-prompt instruction only ·
**BOTH** = prompt rule with a code backstop. Every PROMPT-only rule is a candidate for
promotion to BOTH.

Enforcement spine (in delivery order):
`findings.js` decides what is TRUE → `insights.js` prompts phrase it → `claims.js` strips
unsupported claims before storage → sense-check judge reviews each read → `slack.js` +
`rulecheck.js` gate every delivered line (violations → deterministic fallback + QA ping)
→ `qa.js` self-audit re-checks the delivered brief against computed facts and pings
misses to the founder's Slack.

---

## Data boundary — the reporting day

- [snapshots.js R-DAYLOCK] [ENFORCED] **One capture per brand per day, taken in the morning; the reporting day closes there.** This morning's capture = yesterday's completed activity; today's report is always this-morning vs yesterday-morning = "what they did yesterday". WatchBack never scrapes or reports partial-today data — "we need a full day to end, otherwise there is always a gap from the moment you reported until the day finished" (founder, 12 Aug)
- [snapshots.js R-DAYLOCK] [ENFORCED] A capture-channel day row that already holds real data is IMMUTABLE until tomorrow — admin refreshes, brief re-runs, chat questions and view-time re-checks recompute from stored data, never re-scrape into today. Exception: a FAILED capture (empty) may be completed later — filling a hole is repair, not a boundary shift. Insight/read/weekly channels are never locked (recomputing phrasing from stored captures is always allowed)
- [slack.js] [ENFORCED] Re-running the daily brief at any hour produces the identical comparison and identical content — the pair cannot shift intra-day

## Ads

- [insights.js GUIDE.ads] [PROMPT] New ad launches LEAD the ads read: how many, formats, hook/angle of each with Meta start dates — never compress launches into a bare count (founder, 7 Aug)
- [insights.js GUIDE.ads] [PROMPT] No launches → open with one clause saying so, then still state the standing core message of the live ads, framed as standing state ("still leading with"), never as news
- [insights.js + adsguard.js + claims.js + rulecheck.js R-ADS-01] [BOTH] NEVER state a total or number of active ads or capture volumes — incomplete sample; describe prevalence qualitatively. Launch counts ("6 new ads launched") ARE news and allowed (founder, ~3×)
- [adsguard.js] [ENFORCED] Delta counts ("3 new ads this week") are left intact by the count scrubber; only totals are stripped
- [insights.js] [ENFORCED] The model is never even shown a total ad count — order conveys prevalence, qualitative share words replace counts
- [insights.js + rulecheck.js R-PHRASE-02] [BOTH] Page attribution taxonomy, EXACT terms only: BRANDED (brand's own page), PARTNERSHIP ("X with Brand" pairing), WHITELISTING (third-party page, no pairing). Never a vague "third-party page" (founder, 21 Jul)
- [insights.js] [ENFORCED] Partnership = an actual Meta pairing, not the brand's name in a byline field
- [insights.js GUIDE.ads] [PROMPT] FUNNEL FACTS are ground truth — never claim no third-party pages/off-domain landings unless facts confirm; surface any partnership/whitelisting/advertorial funnel as a notable tactic
- [insights.js GUIDE.ads] [PROMPT] Mention each Facebook page ONCE — chips already list them; name a page only when the page IS the news, refer to the rest collectively
- [insights.js GUIDE.ads] [PROMPT] Page drops are news: a partnership/whitelisted page with ads yesterday and none today gets an explicit retirement call-out — but only per the proof rule below
- [ads.js] [ENFORCED] "Facebook page retired" needs proof (non-capped capture + window past the page's newest ad, or a direct page probe with zero ads); no proof → silent (founder, 21 Jul / 29 Jul)
- [adsguard.js + claims.js] [BOTH] ABSENCE RULE: never say a page/creator/tactic "dropped/went quiet/stopped/was retired" because it's missing from today's capture; at most "not seen in today's capture" (founder, 2 Aug)
- [adsguard.js + claims.js] [BOTH] A thin capture (<50% of typical) may never support a switch/shift/pivot claim (Casa and Beyond, 4 Aug)
- [adsguard.js + claims.js] [BOTH] If every earlier capture was empty, nothing today may be called new/first/changed (Bonafide, 4 Aug)
- [adsguard.js + claims.js] [BOTH] Entities seen in earlier captures may never be described as new/first/just added (founder, 6 Aug)
- [findings.js] [ENFORCED] "New ad" requires BOTH: id never seen before AND Meta start date within 7 days ("new" means this week)
- [findings.js] [ENFORCED] Launch findings carry Meta start date, format, Facebook page, opening hook quote, landing domain
- [findings.js R-ADS-LEADING] [ENFORCED] **"Leading ad" = the LONGEST CONTINUOUSLY-RUNNING ACTIVE ad**, by Meta's own ad_delivery_start_time, with creative duplication (same copy across several ad ids/pages) as the tiebreak. Advertisers kill losers within days, so survival is the proxy for performance (founder, 12 Aug)
- [findings.js R-ADS-LEADING] [ENFORCED] Meta publishes impressions and spend ONLY for political/issue ads — never for commercial ads. NEVER write or imply "most impressions", "top performing", "best performer" or "highest spend": we cannot know it. Say "their longest-running ad"
- [findings.js R-ADS-LEADING] [ENFORCED] The leading ad is computed over the FULL capture, never the model's impression of the ~16-ad prompt sample — that sample is deliberately biased toward third-party/whitelisted ads for coverage, so it can never establish dominance
- [findings.js R-ADS-LEADING] [ENFORCED] No clear winner → say so ("no single dominant angle — captured ads split across X and Y"); never manufacture a lead
- [findings.js R-ADS-FOOTPRINT] [ENFORCED] Where the ads run TO and FROM is ONE sentence, never two: "Every captured ad runs to shop.mikmak.ai and from \"Pacific Foods\" handle." Two findings on the same subject ship as two consecutive sentences whenever the claim gate falls back, and read as a stutter (founder, 12 Aug)
- [ALL SURFACES] [PROMPT] **No sentence may restate the subject of the one before it.** If two consecutive sentences describe the same set of ads/posts/products, they are one sentence. Applies to every generated line, not only the ads read (founder, 12 Aug: "polish the other messages if and when needed")
- [findings.js] [ENFORCED] Launch batch line: human dates ("today"/"since yesterday"), "all video"/"all image" for a uniform mix of 2+, just "video"/"image" for a single ad ("all" of one is nonsense), no bookkeeping parentheticals, no itemisation suffix (founder, 12 Aug ×2)
- [findings.js] [ENFORCED] Launch batch line carries creative substance — newest hook quoted (word-boundary clip, inner quotes normalised) + destination (founder, 9 & 12 Aug)
- [insights.js] [ENFORCED] Guaranteed hook: if a gated ads summary has no quoted hook, the newest hook is appended deterministically (founder, 11 Aug)
- [insights.js GUIDE.ads] [PROMPT] Dominant-hook template: quoted hook — angle in plain marketing terms — destination — tactic named (founder-praised, 9 Aug)
- [insights.js GUIDE.ads] [PROMPT] Unchanged days: never stop at "unchanged" — say what the ad IS (hook, format, destination)
- [insights.js GUIDE.ads] [PROMPT] Always "Facebook page" or "landing page" — never a bare "page"
- [findings.js ads.pages] [ENFORCED] Quoted page names are labelled as what they are: `…run from "Seranova", "Daily Discounts Online" handles.` — the word "handle"/"handles" is appended (founder, 12 Aug)
- [insights.js + rulecheck.js R-PHRASE-01] [BOTH] Page-like campaigns: exactly "optimised for Facebook page likes" / "optimised for Instagram follows" — never "sends traffic to Facebook's login page" (founder, 22 Jul)
- [insights.js] [BOTH] Landing-page format comes from the fetched-and-read page, never inferred from the URL/subdomain; unread pages are said to be unread
- [insights.js GUIDE.ads] [PROMPT] Marketplace destinations are a deliberate channel strategy — never "not driving sales" or a DTC shortfall
- [insights.js] [BOTH] International storefront domains among landings = buying ads into those countries; lead-worthy expansion intel (founder, 22 Jul)
- [insights.js GUIDE.ads] [PROMPT] Offers seen in ads live IN THE ADS ("an ad runs X") — never the brand's current/site-wide sale
- [findings.js + claims.js] [BOTH] The capture is not a census — no universal quantifiers ("all ads", "only", "every page") unless the sentence names the sample
- [insights.js + claims.js] [BOTH] Express absence/duration with dates ("since monitoring began on 18 Jul"), never a number of captures (founder, 25 Jul)
- [insights.js] [ENFORCED] Engagement shown for latest capture only — the model cannot subtract captures and miscall a "drop"
- [ads.js] [ENFORCED] Inactive ads never reported as current; ads going inactive keep an honest INACTIVE badge on older days (founder, 24 Jul)
- [ads.js] [ENFORCED] Newest first — every "first N" surface shows the newest launches (founder, 29 Jul)
- [ads.js] [ENFORCED] Every launched ad counts — no dedup of launch batches (founder, 20 Jul)
- [ads.js] [ENFORCED] Precision-first attribution: never show a random business's ads; name-twin advertisers with different domains are DIFFERENT; unsure → skip (founder, 24 Jul)
- [insights.js] [ENFORCED] Any ad flagged by OFFER TIMING FACTS is pinned into the model's sample so the finding's ad can be identified, not guessed (founder, 24 Jul)
- [signals.js] [ENFORCED] "New ad angle" only when not run in last 14 days; max 2 per brand; brief dedupes variants sharing a hook (founder, 29 Jul)
- [signals.js] [ENFORCED] Tier-2 "new ad" requires Meta start date within 3 days — first appearance in a capture alone is not newness

## Website / Storefront

- [insights.js GUIDE.website] [PROMPT] A SALE = discount/named event/BOGO/GWP/promo code. Free shipping, free returns, new arrivals are OPERATIONAL — never a sale (founder, 17 Jul)
- [occasions.js] [ENFORCED] isSaleBanner encodes the above deterministically
- [insights.js GUIDE.website] [PROMPT] ALWAYS lead with whether a genuine sale is active right now — an ongoing unchanged sale must still be named, by its EXACT occasion name and headline discount
- [insights.js + website.js] [BOTH] NEVER cite a count of discounted products — describe a sale only by occasion + headline discount (founder, 18 Jul)
- [website.js] [ENFORCED] diffWebsite emits only sale STATE transitions; widened/narrowed discounts are churn
- [insights.js GUIDE.website] [PROMPT] Large discounted share with no named sale = likely standing compare-at pricing; say so, never overstate as a fresh sale
- [insights.js + website.js] [BOTH] A NEW PRODUCT LAUNCH is the top website signal — lead with it and NAME the product(s); never just a number; variants collapse to "Name — N variants" (founder, 18 & 22 Jul, 1 Aug)
- [website.js + claims.js] [BOTH] A new LISTING is not a new PRODUCT (-1/-2 handles, shared base names = re-listings); zero-price "FREE gift" SKUs are a promo mechanic; laddered duplicate prices are PRICE TESTING (founder, 1 & 6 Aug)
- [website.js] [ENFORCED] A 0-price placeholder is never a price move (founder, 22 Jul)
- [insights.js + findings.js] [BOTH] ANNOUNCEMENT BARS ROTATE: a slide missing ≠ sale ended; a slide seen ≠ sale started; sale start/end comes ONLY from the ACTIVE SALE facts (founder, 6 Aug)
- [insights.js] [ENFORCED] SALE TIMELINE dates computed in code, quoted verbatim — never model arithmetic (founder, 24 Jul)
- [insights.js] [ENFORCED] Baseline day: promo "already running when monitoring began" — never "launched today" (founder, 30 Jul)
- [insights.js + claims.js + rulecheck.js R-DATE-02] [BOTH] Already-running promo: ACTIVE and unchanged; no start date, no "live/running since", no day counts; wording variance of the same banner (rephrasing, partial reads) is never a new sale (founder, 9 Aug) — but an OCCASION change is, see R-SALE-RENAME
- [findings.js R-SALE-RENAME] [ENFORCED] **A RENAMED SALE IS A NEW SALE.** A change of OCCASION ("Summer Sale" → "Back to School Sale") is a new sale even when the headline discount is identical — the occasion IS the sale. Report it as a new sale, name what it replaced and when that was last captured, and add that the economics are unchanged. Never "renamed, not new"; never "active and unchanged" (Seranova, 12 Aug)
- [findings.js R-SALE-RENAME] [ENFORCED] A rename is dated to the capture that first SAW the new wording, never to a publish date we cannot know — say so explicitly ("we know when we first saw it")
- [findings.js R-SALE-RENAME] [ENFORCED] A rename is news for 6 days, then reverts to unchanged — a client reading Wednesday's brief has not necessarily read Tuesday's
- [findings.js R-SALE-RENAME] [ENFORCED] Rename/replacement requires a clean split at the WORDING level: exactly two wordings, the older one held the bar for a run of ≥2 days, no reappearance after the swap, neither text a substring of the other, identical discount figures. A ROTATING bar and a PARTIAL vision read can never produce a rename (Glov 6 Aug / Frøya 27 Jul)
- [findings.js] [ENFORCED] Countdown values stripped from banner quotes; a timer recurring across days = "evergreen urgency, not a real deadline" (founder, 10 Aug)
- [insights.js] [ENFORCED] "Checked, no sale" is a finding — never "no website data available" (founder, 27 Jul)
- [insights.js] [BOTH] Typical price range = 10th–90th percentile; $0/joke/PR listings are stunts, never the range
- [insights.js] [ENFORCED] Same-day pair or missing feed on either side → no price/product/sale change may be reported (29 Jul)
- [insights.js] [ENFORCED] Products in ANY earlier capture can never be "new" (founder, 6 Aug)
- [website.js] [BOTH] Banner reader reports only what is visible; named occasions kept exactly; non-answers coerced to empty; read from the rendered screenshot, not raw HTML
- [website.js] [ENFORCED] Change-gated screenshots; quiet days labelled "unchanged since <day>" (founder, 20 Jul)

## Email

- [insights.js GUIDE.email] [PROMPT] The LATEST email leads (subject, core message, what it pushes) — never open with cadence arithmetic (founder, 10 Aug)
- [insights.js] [BOTH] Sender-domain alias = deliberate deliverability firewall — bullet-worthy signal; the alias fact is injected by code
- [insights.js] [ENFORCED] Opt-in confirmation emails are never analysed; honest fixed summary when only a confirmation exists
- [insights.js] [ENFORCED] Email absence is never evidence (suppression/scroll-out) — canJudgeAbsence hard-false
- [signals.js] [ENFORCED] Email counts ARE safe to state (verifiable); same-day sends collapse into one line (founder, 25 Jul)
- [email.js] [BOTH] Alias judge: precision first — better to miss the newsletter than attribute another company's email
- [email.js] [ENFORCED] Previews decoded from quoted-printable, invisibles stripped, at store AND read time; all-padding previews rebuild from html (founder, 12 Aug) — rulecheck R-TEXT-01 backstops delivery
- [weekly.js] [ENFORCED] Weekly email counts use the same alias resolver as daily — surfaces can never disagree

## Social

- [insights.js GUIDE.social] [PROMPT] Engagement is CUMULATIVE lifetime — never frame lower counts as a drop/slump/algorithm problem; never compute deltas between captures
- [insights.js] [BOTH] Capture window holds newest N posts — a post out of view was pushed out, never "removed/deleted/replaced" (2 Aug)
- [insights.js] [PROMPT] Platform vocabulary: Reels are IG/FB; TikTok has videos; YouTube has videos/Shorts (founder, 5 Aug)
- [insights.js] [PROMPT] Name the creator exactly as captured, or "a creator post" — never guess (founder, 2 Aug)
- [claims.js] [ENFORCED] "No new posts" requires a connected account (5 Aug)
- [signals.js] [ENFORCED] New-post detection skips empty/failed prior scrapes

## Sales / Offers

- [occasions.js] [ENFORCED] An occasion is STALE only when >45 days away in both directions; all date arithmetic in code, handed as ground truth
- [insights.js] [PROMPT] An out-of-season sale is a LEAD finding — name occasion, distance, meaning (discount = the real price anchoring a fake RRP); quote computed numbers verbatim
- [occasions.js + findings.js] [ENFORCED] Identity travels with the finding (page + quote + link); no running-day counters, no "live since" (founder, 24 Jul & 9 Aug)
- [occasions.js + signals.js + insights.js] [BOTH] Never report countdown timers / "Today only" / "Last chance" as findings or call them fake — common ecom practice (founder, 17 Jul). Out-of-season OCCASIONS still lead
- [insights.js GUIDE.ads] [PROMPT] Rotating-pretext discounting = ONE deliberate anchor-pricing tactic, never several stale sales itemised (Seranova case)
- [insights.js] [PROMPT] A live sale is ALWAYS material — name occasion, size, still running; never routine noise
- [insights.js] [PROMPT] The brand's CURRENT sale comes only from their WEBSITE; ad offers are ad-creative content, said as "in an ad" (founder, 20 Jul, ×3)
- [signals.js] [ENFORCED] Stale-offer announced ONCE (fingerprint state; previews never consume it); one line per occasion, merged (founder, 24 Jul)
- [signals.js] [ENFORCED] Slack sale trigger: product-feed transition primary; banner fallback rotation-safe; sale→non-sale slide rotation is never "sale ended" (founder, 17 Jul)
- [signals.js R-SALE-NEW] [ENFORCED] A first-ever sale announcement says NEW in the text itself — `*New sale live* — “…”` (bold in Slack, banner quoted verbatim) — so it is 100% clear it was not there before (founder, 12 Aug)
- [signals.js] [ENFORCED] CATCH-UP: captured ≠ announced — a live sale banner never through a DELIVERED brief fires once (_salestate) (founder, 12 Aug — Seranova Back-to-School)
- [slack.js R-SALE-LEADS] [ENFORCED] When a sale signal fires (transition or catch-up), the website row IS the announcement (`*New sale live* — “Back to School Sale: up to 58% off”` — bold status, em-dash, banner quoted verbatim) — never an "active and unchanged" read with an ❗ on it; the ❗ and the sentence must agree (founder, 12 Aug — Seranova)
- [qa.js R-MISS-01..03] [ENFORCED] Self-audit: a computed sale / new-product / stale-offer signal missing from the delivered brief pings the founder (12 Aug)
- [occasions.js] [ENFORCED] One meaning-based "same banner" definition shared by all surfaces

## Dates & Language

- [insights.js + occasions.js] [ENFORCED] The model is always told today's date
- [insights.js + claims.js + rulecheck.js R-DATE-02] [BOTH] Time-anchor every state as NEW or UNCHANGED; never "live/running since <date>", never durations
- [insights.js + slack.js] [BOTH] "Today" is written bare; delivery re-anchors to the reader's clock ("today"→"yesterday"); genuine earlier dates stay dates (founder, 10 Aug)
- [rulecheck.js R-DATE-01] [ENFORCED] Raw ISO dates in the brief only for genuine launch/check dates; everything else relativized (founder, 12 Aug)
- [findings.js + rulecheck.js R-PROV-01] [ENFORCED] NEVER state the comparison window in the brief ("Storefront compared 2026-08-11 → 2026-08-12", any date→date range) — briefs are DAILY, so "vs yesterday" is implicit and stating it only confuses. Change/no-change lines read absolutely ("Storefront unchanged — same prices, products and sale."); provenance dates live in evidence fields, never prose (founder, 12 Aug: "Slack messages are being sent daily!!!")
- [insights.js + claims.js] [BOTH] Never count captures — use dates or "since monitoring began on <date>"
- [insights.js] [PROMPT] Newsroom order: event first, plain words, then interpretation; plain language a marketer uses; split sentences needing semicolon+dash (founder, 22 Jul)
- [insights.js] [PROMPT] Brand-initials pages ("BF USA") are the brand's own page, never whitelisting (founder, 6 Aug)
- [insights.js] [PROMPT] Name the channel inside the sentence, naturally
- [insights.js] [PROMPT] English only; non-English only as verbatim competitor quotes (17 Jul)
- [insights.js + slack.js + rulecheck.js R-TEXT-02/R-QUOTE-01] [ENFORCED] Never cut mid-word/clause; unfinished clauses dropped whole; quotes/parens healed (founder, 12 Aug)
- [claims.js] [ENFORCED] Never invent internal mechanisms ("below our capture threshold") (6 Aug)
- [signals.js] [ENFORCED] Funnel platforms explained in plain words ("MikMak, a 'where to buy' page…") (founder, 22 & 24 Jul)

## Links & URLs

- [adsguard.js + slack.js + rulecheck.js R-URL-01] [ENFORCED] Anything after "?" is tracking noise — stripped everywhere, delivery-backstopped (founder, 10 Aug)
- [ads.js] [ENFORCED] Never hyperlink a dead/unverified page; dead funnels keep the domain fact, lose the link (founder, 23 Jul)
- [findings.js] [ENFORCED] Dead landing (404/410) reported with check date, "Do not link it"; zero-width-space de-linkification (founder, 9 & 10 Aug)
- [findings.js + rulecheck.js R-CLAIM-01] [ENFORCED] Same-brand redirects (incl. hyphen variants) are storefront hops, never retired funnels; redirect findings name the exact probed URL, never "domain X redirects" (founder, 12 Aug)
- [insights.js] [BOTH] Cite funnels by FULL working URL; PAGE NOT LOADING pages named plainly, never linked
- [ads.js] [ENFORCED] App deep-links/shorteners/social redirects never surfaced as funnels
- [signals.js] [ENFORCED] Long ad URLs linked behind "view ad ↗" labels

## Slack brief composition

The agreed layout (founder, 12 Aug — "format it somehow so it's readable and not a pile
of text"). One block per brand, one row per channel, dividers between brands:

```
WatchBack daily · Wed 13 Aug
━━━━━━━━━━━━━━━━━━━━━━━━━━━

*Seranova*

❗  *Website* — New sale: "Back to School Sale: up to 58% off" replaced
     "SUMMER SALE: UP TO 58% OFF", first captured yesterday. Same headline
     discount, new occasion — the economics are unchanged.

❗  *Ads* — 6 new ads launched yesterday, all video. Newest opens
     "Doctors are begging you to stop" → seranova.com, from "Seranova"
     and "Daily Discounts Online" handles.

     *Social* — No new posts since 9 Aug. Latest is still the founder-story
     Reel on TikTok.

     *Email* — No sends since 7 Aug. Last was "Your 58% is ending".

━━━━━━━━━━━━━━━━━━━━━━━━━━━

*Pacific Foods*

     *Ads* — No new ads since 5 Aug. Longest-running is still "Real
     ingredients, real simple" → shop.mikmak.ai, from "Pacific Foods" handle.

     *Social* — Not checked: no handles confirmed yet.

━━━━━━━━━━━━━━━━━━━━━━━━━━━

View the full dashboard →
```

- [slack.js R-BRIEF-FORMAT] [ENFORCED] NO decorative emoji: no channel glyphs (📣📱🛒✉️), no status badges (💡/🔹/✅) — the labels already say it. The ONLY emoji is ❗, marking a channel with news, hanging in the LEFT GUTTER so every move is scannable down one edge without reading a word (founder, 12 Aug)
- [slack.js R-BRIEF-FORMAT] [ENFORCED] EVERY subscribed channel gets its OWN ROW, every day — never collapsed into a shared "quiet" line. A brand is a predictable block of rows, so the reader's eye finds Social in the same place every morning (founder, 12 Aug)
- [slack.js R-BRIEF-FORMAT] [ENFORCED] Rows sort NEWS FIRST within each brand, so the ❗ rows cluster at the top instead of scattering
- [slack.js R-BRIEF-FORMAT] [ENFORCED] Blank line between rows and a divider between brands — a brief must never read as a wall of text. Each row opens with ONE clause before its detail
- [slack.js R-BRIEF-FORMAT] [ENFORCED] A QUIET row states how long the channel has been quiet AND what still stands: "No new ads since 5 Aug. Longest-running is still X" / "No new posts since 9 Aug. Latest is still X" — the age is the intelligence (founder, 12 Aug)
- [slack.js R-BRIEF-FORMAT] [ENFORCED] Three states, never two: news · checked-and-quiet (with the date it went quiet) · NOT CHECKED (capture failed or channel not connected — said plainly, never dressed as quiet). Once a row prints every day, a failed capture would otherwise read as "the competitor is quiet", which is a false claim (Pannonian Padel, 5 Aug)
- [slack.js R-BRIEF-FORMAT] [ENFORCED] A brand with nothing anywhere still gets its rows — silence must never look like a failure

- [slack.js] [ENFORCED] SYNC RULE: brand blocks mirror the app's per-channel summaries; ❗ marks new signals; brief can never contradict the app (founder, 10 Aug)
- [slack.js R-SOCIAL-ROW + qa.js R-MISS-04] [ENFORCED] A channel the app displays always gets a row: if posts are captured but the AI social read gated to empty, the row ships deterministically — new-post line, else "No new posts on the tracked profiles." An empty read can never silently drop a channel; the self-audit pings R-MISS-04 if it ever happens (founder, 12 Aug — Pacific Foods: 9 IG posts in the app, no Social row in the brief)
- [slack.js] [ENFORCED] No verdict quotes in the brief (clipped nonsense, 10 Aug); every block carries one ads-recap line with the core message (client feedback, 8 Aug)
- [slack.js + rulecheck.js] [ENFORCED] DELIVERY GATE: every line passes rulecheck after scrubbing; violations → deterministic fallback text + QA ping to founder (12 Aug)
- [qa.js] [ENFORCED] SELF-AUDIT after real sends: deterministic miss-checks + model judge over delivered text vs computed facts; issues ping the founder's Slack (12 Aug)
- [signals.js] [ENFORCED] Priority order: sale change → funnel → new FB page → products → ad angle; conservative (unsure → silent); ONE definition of new (findings engine is sole authority, 6 Aug)
- [signals.js] [ENFORCED] New funnel = first appearance since Monday, labelled "(first seen <day>, still new this week)" (founder, 24 Jul)
- [signals.js] [ENFORCED] Same-type signals merge into one line (founder, 22 Jul); spare formatting (badge carries status)
- [slack.js] [ENFORCED] Badges: 💡 priority / 🔹 routine / ✅ quiet; stale reads (>2 days) never quoted as fresh; missing reads → deterministic lines so news is never dropped
- [slack.js] [ENFORCED] Demo brands appended and labelled, never mixed in (founder, 6 Aug)
- [signals.js] [ENFORCED] Only REAL deliveries commit announce-once state — previews never consume it

## Weekly report

- [weekly.js] [ENFORCED] Findings-first; headline/summary/channel text passes the claims gate; no active-ad or product totals; only genuinely-launched ads and this-week posts/emails cited
- [weekly.js] [ENFORCED] Every launched ad counts, no dedup (founder, 20 Jul); sale STATUS never discounted-product counts
- [weekly.js] [PROMPT] Channel inactivity only when data explicitly says nothing was published; engagement is lifetime; materiality filter; output-shape limits (headline ≤14 words, etc.)
- [weekly.js] [ENFORCED] Served weekly = most recent COMPLETED Mon–Sun week; social aggregated across daily captures deduped by URL
- [weekly.js + brand.js] [ENFORCED] Tenant-neutral: no customer's brand/prices in shared rows; founder's own brand removed from anything client-visible

## General honesty / grounding (the prime directive)

- [insights.js] [PROMPT] **CREDIBILITY IS THE PRODUCT**: one wrong or overconfident claim costs more trust than ten missed insights; hedge in the sentence or leave it out — every other rule serves this one
- [findings.js + insights.js] [ENFORCED] Findings-first architecture: code decides WHAT is true, the model only phrases it; provable or absent
- [claims.js] [ENFORCED] Deterministic claim validator is the last gate before storage — "prompt rules alone never held"; unsupported sentences removed; stripping never leaves fragments; every block logged
- [claims.js] [ENFORCED] No contradiction of the computed diff; no "new" for known entities; no identity guesses ("most likely X" banned); honest limitation statements always pass
- [insights.js] [BOTH] Sense-check LLM judge on every read; full-section gate (summary + bullets + apply) with deterministic re-gate LAST; threat assessment gets the strictest gate; rejected text is never restored, fallback prefers substance over inventory boilerplate (founder, 11 Aug)
- [insights.js] [BOTH] Stay inside the evidence: never spend/revenue/traffic/conversions, never "primary growth engine"; like-for-like dated comparisons are wanted
- [insights.js] [PROMPT] Reader test, usefulness test, materiality filter, calibrated certainty (facts flat, inferences hedged), sanity-check every number
- [insights.js] [ENFORCED] Tenant-neutral shared reads; per-viewer tailoring is a private overlay; skipped read failures ledgered, never silent
- [rulecheck.js R-TEXT-03] [ENFORCED] No placeholder junk (undefined/null/NaN) on any surface
