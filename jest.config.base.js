module.exports = {
  preset: 'ts-jest',
  setupFilesAfterEnv: [require.resolve('./packages/repo-mock/tests/setup.ts')],
};
