const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');

module.exports = {
  output: { path: join(__dirname, '../../dist/apps/gateway') },
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/index.ts',
      tsConfig: './tsconfig.app.json',
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: false,
      // Copy the regenerated OpenAPI spec next to the bundle so the public Swagger UI (/api-docs)
      // can load + parse it at runtime in the built image (the repo tree is gone there). Loaded via
      // a path resolved relative to the bundle (__dirname) in src/docs.ts.
      assets: [
        {
          glob: 'openapi.yaml',
          input: join(__dirname, '../../docs/api'),
          output: '.',
        },
      ],
    }),
  ],
};
