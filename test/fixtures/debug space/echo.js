let n = 1;
process.stdin.once('data', d => {
  n = n + 1;
  console.log('got', String(d).trim(), n);
  process.stdin.destroy();
});
