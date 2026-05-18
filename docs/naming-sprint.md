# Naming Sprint

## Goal

Find a short, memorable, one-word name for Zoottle's next identity.

The product is becoming an agent-driven operating environment: integrated browser, files, terminals, code harnesses, worktrees, review surfaces, and automation loops. The name should feel big enough for an OS-like system without literally saying `agent`, `code`, `browser`, or `OS`.

## Working Positioning

For developers building with AI agents, this is the local operating layer where agents can see, act, edit, browse, run, and coordinate under human control.

Unlike chat-first coding assistants, it gives agents an environment: browser, filesystem, terminals, diffs, logs, panes, tools, and review loops.

## Naming Constraints

- One word.
- Ideally 4-6 letters, acceptable up to 7 if excellent.
- Exact `.dev` or `.ai` should be available in a fast RDAP screen.
- Prefer exact `.dev`; `.ai` is acceptable if the name is stronger.
- Easy to say after reading once.
- Easy to spell after hearing once.
- No hyphens, numbers, odd casing, or forced suffixes like `-ly`, `-ify`, `-bot`, `-agent`, `-os`.
- Avoid names that feel too 2018 SaaS, too crypto, too AI-wrapper, too cute, or too enterprise middleware.

## Desired Feel

- Clean like `zed.dev`, `starch.dev`, `linear.app`, `vercel.com`, `figma.com`.
- Sparse, confident, slightly technical.
- A little mysterious is acceptable.
- Should look good in a terminal prompt, browser tab, GitHub org, app dock icon, and Product Hunt headline.
- Should support a serious product narrative without sounding heavy.

## Strategic Naming Territories

### Abstract Coinage

Invented but pronounceable names like `Figma`, `Vercel`, `Monzo`, `Kaivu`.

Why: strongest path for available short domains, trademarkability, and clean search ownership.

Risk: may need a stronger launch story because meaning is learned.

### Evocative Natural/Material Words

Concrete words like `Starch`, `Slate`, `Flint`, `Loom`, `Cairn`.

Why: memorable, visual, easy to brand.

Risk: most good `.dev` domains are already taken; real words can have search and trademark collisions.

### Latent Action Words

Names that quietly imply acting, routing, seeing, holding, or coordinating without describing the product.

Why: keeps relevance without becoming generic.

Risk: easy to drift into `Act*`, `Agent*`, `Pilot*`, which feels too literal or dated.

## Evaluation Rubric

Score each candidate 1-5.

- Fluency: can I say it correctly on first sight?
- Spellability: can someone type it after hearing it?
- Memorability: does it stick after one exposure?
- Distinctiveness: does it avoid category cliches?
- Strategic fit: can it plausibly hold the product story?
- Visual fit: does it look good as lowercase text and in a URL?
- Domain fit: exact `.dev` or `.ai` available.

Drop names that are hard to pronounce, feel like random syllables, sound too close to existing devtools, or require explanation before they are acceptable.

## Current Observations

- Short real-word `.dev` names are nearly exhausted.
- Product Hunt devtool names cluster around short coinages, mascots, and control-surface metaphors.
- The best available territory is clean coined names with familiar phonetics.
- `Kaivu` is directionally interesting because it is short, calm, ownable, and not literal.
- `Operant` has strong meaning but feels a bit dated and academic.
- `Zoottle` is memorable but too playful for the product's current ambition.

## Candidate Families To Explore Next

- `Kai/Kei/Koi/Kyu` family: calm, compact, slightly technical.
- `V/R/N/L` family: clean SaaS phonetics, e.g. `Vera`, `Navo`, `Luma`, but less taken through invented variants.
- Hard plosive family: `K`, `T`, `D`, `G`, `B` for stronger recall.
- Soft system family: names suggesting a place, layer, or surface without saying it.

## Pass 2 Results

Method:

- `.dev` screened through RDAP.
- `.ai` screened through `whois.nic.ai` because `.ai` RDAP returned 403.
- These are fast availability signals only, not legal or purchase guarantees.

### Strongest Cluster

The `Kai/Vai/Nai` family produced the best balance of brevity, fluency, and availability.

| Candidate | Fast domain signal | Notes |
| --- | --- | --- |
| Kaivu | `kaivu.dev` screened available; `kaivu.ai` screened available in an earlier pass | Best current candidate. Clean, short, calm, ownable, close to the desired `zed.dev` / `starch.dev` feel. |
| Vaivu | `vaivu.dev` screened available; `vaivu.ai` screened available in an earlier pass | Similar structure to Kaivu, slightly more synthetic and energetic. |
| Naivu | `naivu.dev` and `naivu.ai` screened available | Clean, but visually close to `naive`, which may be a serious negative. |
| Kaivo | `kaivo.dev` screened available in an earlier pass; `.ai` screened taken | Good sound, but slightly less distinctive than Kaivu. |
| Kaiva | `kaiva.dev` screened available | Softer and more feminine; plausible but less technical. |
| Keivu | `keivu.dev` screened available in an earlier pass | Good sibling to Kaivu, but pronunciation is less obvious. |
| Laivu | `laivu.dev` screened available | Smooth, but less memorable and less ownable than Kaivu. |

### Other Available Signals

| Candidate | Fast domain signal | Notes |
| --- | --- | --- |
| Avren | `avren.dev` screened available | Strong, restrained, more enterprise/SaaS. |
| Kaime | `kaime.dev` and `kaime.ai` screened available | Short and clean; pronunciation may split between `kaym` and `kai-me`. |
| Kaidi | `kaidi.dev` screened available earlier; `kaidi.ai` screened available | Friendly, but may feel too cute. |
| Aveta | `aveta.dev` screened available | Good shape, less distinctive. |
| Aveti | `aveti.dev` screened available | Good shape, slightly medication-like. |
| Avari | `avari.dev` screened available | Polished, but closer to existing brand patterns. |
| Veimu | `veimu.dev` and `veimu.ai` screened available | Interesting but less immediately fluent. |
| Veiru | `veiru.ai` screened available | Good visual shape, pronunciation uncertain. |
| Leivo | `leivo.ai` screened available | Pleasant, maybe too soft. |
| Keiru | `keiru.ai` screened available | Clean, but pronunciation uncertain. |

## Current Recommendation

`Kaivu` is the name to beat.

Reasons:

- Five letters.
- Two syllables.
- Exact `.dev` screened available.
- Exact `.ai` screened available in the initial WHOIS pass.
- Pronounceable as `kai-voo`.
- Looks good lowercase: `kaivu`.
- Does not sound like an AI wrapper, SaaS suffix name, or literal developer tool.
- Has enough blank space to become a brand rather than merely describe a feature.

Risks:

- Some people may pronounce it `kay-voo` instead of `kai-voo`; this is probably acceptable.
- Meaning is invented/opaque, so launch copy needs to define the category clearly.
- Must still pass trademark, social handle, GitHub org, package, and search checks.

## Later Validation

This sprint only screens domains. Before committing:

- Check registrar availability and price.
- Search USPTO/WIPO and relevant software classes.
- Search GitHub orgs, npm packages, X/GitHub handles, and Product Hunt.
- Run a quick five-second recall test with 5-10 target users.
- Say it in launch copy: `Meet NAME`, `NAME is an agent-native workspace`, `Open NAME`, `NAME ran the task`.
