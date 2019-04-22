export default {
  files: ['src/__tests__/**/*.ts'],
  failFast: true,
  verbose: true,
  serial: true,
  timeout: '30s',
  compileEnhancements: false,
  extensions: ['ts'],
  require: ['ts-node/register']
}
