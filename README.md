# image-panel

v0.3.5a

Yes this is another image viewer / photoframe / thing. Here's a few reasons this one deserves to exist:

- It's a custom web component (bespoke HTML element) so you don't have to use Javascript.
- Uses a separate config file to update without having to republish your page (nested img support & folder loading are on roadmap)
- Designed for presentation use - flexible control methods, fails silently.
- Allows you to add custom style info on a per-image basis. 
- No dependencies.
- Very compact (12Kb minified atm).

This isn't aiming to be another image gallery viewer - it's intended more as a component in other things, it just so happens to make a decent slideshow viewer as it is. It has no UI, though hooks are provided so you can add one. By default it expands to fill whatever container it's placed in, but you can always style it differently if you like.

This is alpha. It's a component-ised version of the slideshow viewer I've had on my own site for ages, and has plenty of shoddy code to prove it. Future versions will improve this and add some vital extra functionality, but don't expect an all-singing, all-dancing featureset, this isn't meant for that.

## Usage

Embed the `dist/ImagePanel.js` file in your HTML (typically at the end of `<body>`):
```html
<script src="pathto/ImagePanel.js"></script>
```

Add a `<image-panel>` element in the desired location. Set the `data` attribute to point to a JSON config file. Use the sample one in `tests` as a guide until this README is improved.

```html
<image-panel data="pathto/slideshow.json"></image-panel>
```

