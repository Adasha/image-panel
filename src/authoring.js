/**
 * The helpers image-panel uses internally, for tools that preview or edit slideshows: focal point
 * parsing and placement, fill-panel covering, and reading image metadata. Import it as `image-panel/authoring`.
 *
 * They're the same code the panel runs, so a tool built on them places and crops images as the panel will.
 * Use them on your own elements, not on the panel's own slides: placeFocalPoint and coverPanel remember the
 * images they've changed, so that they can run again as the box resizes, and that memory isn't shared with
 * the panel's copy of the code if it's loaded separately (for example, from dist).
 *
 * Not part of the stable API until 1.0, like the rest of image-panel.
 */

export {parseFocalPoint, parseFocalRange, placeFocalPoint, focalMotion} from './focus.js';
export {coverPanel, motionCoverZoom, clampEasing} from './cover.js';
export {readMetadata} from './metadata.js';
