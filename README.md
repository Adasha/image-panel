# photoframe
yes this is another image viewer / photoframe / thing. Here's a few reason's this one deserves to exist:

- It's a custom web component (bespoke HTML element) so it's trivial to use
- ZERO dependencies
- Very compact (12Kb minified atm)

This isn't aiming to be another image gallery viewer though - think of it more as a physical digital photo frame that is meant to sit in the background and show you images passively.

This is alpha. It's a component-ised version of the slideshow viewer I've had on my own site for ages, and has plenty of shoddy code to prove it. Future versions will improve this and add some minimal extra functionality, but don't expect an all-singing, all-dancing featureset, this isn't meant for that.

To use, add the /dist/PhotoFrame.js to your HTML and use the \<photo-frame\> element name. You need to set the 'data' attribute to point to a JSON file with the gallery information. Use the sample one as a guide until this README is improved.
