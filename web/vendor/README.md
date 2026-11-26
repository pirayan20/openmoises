Signalsmith Stretch 1.3.2 (MIT, https://signalsmith-audio.co.uk/code/stretch/), copied from the npm package signalsmith-stretch.
three.js 0.187.0 (MIT, https://threejs.org), tree-shaken to the classes web/home-bg.js uses:
  echo "export { WebGLRenderer, Scene, OrthographicCamera, PlaneGeometry, ShaderMaterial, Mesh, Vector2, Color } from 'three';" > entry.js
  npx esbuild entry.js --bundle --minify --format=esm --legal-comments=inline --outfile=three.min.js
