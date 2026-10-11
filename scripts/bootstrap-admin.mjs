import { bootstrapLocalTestAdmin, grantFirstSuperadminOffline } from '../src/system/bootstrap.ts';

// Do not accept passwords in argv, generate credentials, or connect to SMTP.
try {
  let result;
  if (process.env.SYSTEM_BOOTSTRAP_LOCAL_TEST === '1') {
    if (process.argv.length > 2) throw new Error('Do not combine local fixture mode and offline deployment arguments');
    result = await bootstrapLocalTestAdmin({ enabled: true,
      databasePath: process.env.SYSTEM_BOOTSTRAP_TEST_DATABASE ?? '',
      email: process.env.SYSTEM_BOOTSTRAP_TEST_EMAIL ?? '',
      password: process.env.SYSTEM_BOOTSTRAP_TEST_PASSWORD ?? '' });
  } else {
    const argumentsMap = new Map();
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = process.argv[index];
      const value = process.argv[index + 1];
      if (!['--database', '--email', '--user-id', '--confirm'].includes(key) || !value || argumentsMap.has(key)) throw new Error('Invalid offline bootstrap arguments');
      argumentsMap.set(key, value);
    }
    result = grantFirstSuperadminOffline({ databasePath: argumentsMap.get('--database') ?? '',
      email: argumentsMap.get('--email'), userId: argumentsMap.get('--user-id'), confirmation: argumentsMap.get('--confirm') ?? '' });
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Local bootstrap failed');
  process.exitCode = 1;
}
