# Pending: top:0 for side navs when header and filters are both off-screen

When both `#main-header` and `#filterFieldsHolder` are not visible (scrolled out of view),
`#side-nav-fixed` and `#rail-shell` should use `top: 0`. As the user scrolls back up,
filters appear first (top = filter height), then header (top = header height).

## Proposed change

In `computeTopNavOffset()` in `localsite/js/localsite.js` (~line 5249), change the
`headerbarOffset` calculation from `.height` to `.bottom`:

```js
// Before
var headerbarOffset = mainHeader ? Math.round(mainHeader.getBoundingClientRect().height) : 0;

// After
var headerbarOffset = mainHeader ? Math.max(0, Math.round(mainHeader.getBoundingClientRect().bottom)) : 0;
```

Using `.bottom` instead of `.height`: when the element is off-screen, `.bottom <= 0` and
`Math.max(0, ...)` clamps it to 0. When visible, `.bottom` equals the element's height
(since it's stuck at `top: 0`).

A scroll listener may also be needed so `computeTopNavOffset()` fires during scroll,
not only on DOM mutations (MutationObserver on `#headerbar`/`#filterFieldsHolder`,
IntersectionObserver on `#local-header`).

## Open question before implementing

`#main-header` is `position: sticky; top: 0` (base.css line 611). Sticky elements don't
naturally scroll off — `.bottom` stays equal to `.height` while sticky. The element only
"disappears" via the `headerbarhide` class (`display: none`), which already fires the
MutationObserver and sets `headerbarOffset = 0`.

**Need to confirm:** is there a real scroll state on `project/` where both are off-screen
but no MutationObserver fires? If not, the current code may already be correct and no
change is needed.
