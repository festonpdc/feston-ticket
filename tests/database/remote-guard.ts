export function assertIsolatedDestructiveTarget() {
  if (process.env.TEST_DATABASE_URL && process.env.ALLOW_DESTRUCTIVE_REMOTE_TESTS !== '1') {
    throw new Error('Destructive integration suite requires isolated test database. Set ALLOW_DESTRUCTIVE_REMOTE_TESTS=1 only for a dedicated QA database.');
  }
}
