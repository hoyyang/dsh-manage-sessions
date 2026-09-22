import type { UserConfig } from 'tsdown'

const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const client: UserConfig = {
  name: '@dsh-external/dsh-manage-sessions/client',
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: false,
  clean: false,
  deps: {
    neverBundle: [...EXTERNALS],
    alwaysBundle: (id: string) => !EXTERNALS.includes(id),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-manage-sessions", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
    codeSplitting: false,
  },
}

export default [client] satisfies UserConfig[]
