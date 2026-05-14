# UX Principles

This document defines the default UI standards for Kaivo. The goal is a clean, compact, minimal product UI that is fast to scan, easy to operate, and resistant to visual noise.

These principles should guide new screens, component choices, and cleanup work. When in doubt, choose the simpler, denser, quieter option.

## Core Principles

### 1. Compact by Default

Use tight spacing, modest type scales, and minimal chrome. The UI should feel built for daily work, not padded like a marketing page.

Prefer:

- Short vertical rhythm
- Dense rows
- Small controls
- Inline metadata
- Plain section headers

Avoid:

- Large hero areas
- Oversized empty states
- Excessive padding around routine content
- Components that force users to scroll without adding clarity

### 2. Lists Are Not Cards

Repeated items should usually be rows, tables, grouped lists, or simple divided sections. Cards create unnecessary visual boundaries and make dense operational interfaces harder to scan.

Prefer:

- List rows with clear primary text and compact metadata
- Tables for comparable structured data
- Simple dividers for separation
- Inline status and actions

Avoid:

- Card grids for ordinary objects
- Boxed rows with shadows or heavy borders
- Repeating headers inside each item
- Large per-item padding

Cards are acceptable only when each item contains rich, heterogeneous content that benefits from strong separation.

### 3. No Duplicate Information

Each piece of information should appear once unless repetition materially improves comprehension.

Avoid repeating:

- Page title and section title with the same text
- Object name in both a header and row body
- Status in multiple nearby places
- Timestamps in both summary and detail sections
- Metadata already implied by the current view

Before adding text, ask whether the user already knows it from the surrounding context.

### 4. Hierarchy Through Restraint

Create hierarchy with typography, alignment, spacing, and subtle separators before using color, shadows, backgrounds, or containers.

Prefer:

- Font weight changes
- Muted secondary text
- Alignment and indentation
- Thin borders
- Small spacing shifts

Avoid:

- Loud color blocks
- Heavy shadows
- Multiple nested panels
- Competing badges and icons

### 5. Show Only What Helps Decide

Default views should show the information required to understand state and take the next action. Secondary details belong in expansion, detail panes, tooltips, or drill-in views.

Prefer:

- One strong primary label
- One short secondary description when needed
- Status only when it changes the user's decision
- Progressive disclosure for verbose data

Avoid:

- Showing every available field by default
- Long descriptions in list rows
- Multiple metadata lines where one would do
- Debug details in primary UI unless debugging is the purpose of the page

### 6. Actions Stay Close to Context

Controls should live near the thing they affect. Users should not have to map a global action bar back to an individual row, section, or object.

Prefer:

- Row-level actions for row-level effects
- Section actions in section headers
- Primary page action in the page header
- Destructive actions behind confirmation when impact is high

Avoid:

- Detached button clusters
- Repeating the same primary action in multiple places
- Toolbars that mix unrelated scopes
- Hidden actions that are required for common workflows

### 7. Surfaces Should Earn Their Borders

Every panel, border, background, divider, and container must clarify grouping, state, or interaction. If a surface does not help the user understand the UI, remove it.

Prefer:

- Bare layout when grouping is obvious
- Thin dividers for lists
- Light background changes only for interactive or selected states
- One level of containment where possible

Avoid:

- Nested cards
- Decorative borders
- Containers around single obvious sections
- Background changes used only to make a page feel designed

### 8. Quiet System States

Empty, loading, success, warning, and error states should be clear without becoming theatrical.

Prefer:

- Concise copy
- Direct next steps
- Small inline indicators
- Plain skeletons or spinners only where useful

Avoid:

- Oversized illustrations
- Long explanations before the action
- Success banners for routine operations
- Error states that obscure available recovery actions

## Typography

Typography should create a compact hierarchy with as few sizes and weights as possible.

### Type Scale

Use this scale as the default unless an existing component already defines a compatible project token.

| Use | Size | Weight | Line height | Notes |
| --- | --- | --- | --- | --- |
| Page title | 20px | 600 | 28px | One per page. Avoid subtitles unless useful. |
| Section title | 15px | 600 | 22px | Used for major page sections. |
| Row primary text | 14px | 500 | 20px | Main label in lists, tables, and object rows. |
| Body text | 14px | 400 | 20px | Default readable text. |
| Secondary text | 13px | 400 | 18px | Metadata, descriptions, timestamps. |
| Caption | 12px | 400 or 500 | 16px | Labels, compact metadata, helper text. |
| Code | 12px or 13px | 400 | 18px | Use monospace for commands, paths, IDs, and logs. |

### Typography Rules

- Use sentence case for headings, labels, and buttons.
- Keep page titles short and specific.
- Do not pair a page title with a redundant subtitle.
- Prefer muted secondary text over smaller unreadable text.
- Use bold sparingly; weight should mark hierarchy, not decoration.
- Use monospace only for technical values: commands, paths, IDs, ports, hashes, environment variables, and logs.

## Layout And Spacing

Use a compact spacing system. Prefer smaller gaps and rely on alignment to create structure.

| Use | Spacing |
| --- | --- |
| Tight inline gap | 4px |
| Standard inline gap | 8px |
| Row vertical padding | 6px to 10px |
| Control gap | 8px |
| Section internal gap | 12px |
| Section-to-section gap | 20px to 24px |
| Page edge padding | 16px to 24px |

Spacing rules:

- Start compact and increase only when readability suffers.
- Use dividers instead of large gaps when separating repeated rows.
- Avoid stacking multiple spacing mechanisms between the same elements.
- Keep dense operational pages within a single scan whenever possible.

## Standard Components

### Page Header

Use for the page title and primary page-level action.

Structure:

- Title
- Optional short description only when it adds context not obvious from the title
- Optional primary action aligned to the end

Avoid breadcrumbs, repeated object names, and large header blocks unless the page has deep navigation context.

### Section Header

Use for meaningful content groups.

Structure:

- Section title
- Optional count or compact metadata
- Optional section-scoped action

Avoid wrapping every section in a card. A header plus spacing or a divider is usually enough.

### List

Use for repeated objects that do not require column comparison.

Structure:

- Primary label
- Compact metadata in the same row when possible
- Optional one-line secondary description
- Status and actions aligned consistently
- Thin divider between rows

Do not use cards for ordinary lists.

### Table

Use when users need to compare values across rows.

Rules:

- Keep columns limited to decision-making fields.
- Right-align numeric values when comparison matters.
- Use compact headers.
- Keep row actions at the end.
- Avoid wrapping long prose in table cells.

### Detail Pane

Use when secondary details are useful but should not dominate the list or main page.

Rules:

- Keep the parent list visible when possible.
- Show the selected object's primary facts first.
- Group details with plain headings and dividers.
- Avoid repeating all fields already visible in the parent row.

### Form

Use forms for creating or editing configuration.

Rules:

- Keep labels short and specific.
- Put helper text below the field only when necessary.
- Group related fields with plain section headings.
- Prefer inline validation near the field.
- Keep submit actions at the end of the form or in a sticky footer for long forms.

### Button

Use buttons for explicit actions.

Variants:

- Primary: one main action per page or form area.
- Secondary: normal actions.
- Ghost: low-emphasis contextual actions.
- Destructive: irreversible or high-impact actions.

Rules:

- Do not show multiple primary buttons in the same scope.
- Button text should be a verb phrase.
- Prefer compact button sizes in operational UI.
- Use icon-only buttons only when the icon is universally clear or has an accessible label.

### Badge

Use badges for compact state, category, or count indicators.

Rules:

- Keep badge text short.
- Use muted styling by default.
- Reserve strong color for states requiring attention.
- Do not badge information already clear from the row or section.

### Tabs

Use tabs for switching between peer views of the same object or area.

Rules:

- Keep tab labels short.
- Do not use tabs as a substitute for page navigation.
- Avoid nesting tabs.
- Show counts only when they affect user decisions.

### Empty State

Use empty states to explain why content is missing and what to do next.

Structure:

- Short title
- One sentence of explanation if needed
- One direct action when available

Avoid large illustrations, broad product education, and multiple competing actions.

### Loading State

Use the least disruptive loading indicator that accurately reflects the wait.

Prefer:

- Inline spinner for small updates
- Skeleton rows for list/table loading
- Existing content with a subtle pending state for refreshes

Avoid full-page loading screens unless the page cannot render meaningful structure yet.

### Error State

Use errors to explain what failed and how to recover.

Structure:

- What failed
- Why, if known
- Recovery action

Avoid raw stack traces in primary UI unless the page is explicitly for debugging.

## Review Checklist

Before merging UI work, check:

- Does the page avoid unnecessary cards and nested surfaces?
- Is any information duplicated?
- Can the primary workflow be completed without scanning unrelated details?
- Are lists compact and easy to compare?
- Are actions placed near the thing they affect?
- Is typography using the smallest sufficient hierarchy?
- Are empty, loading, and error states quiet and direct?
- Would removing a border, background, icon, or label make the UI clearer?
