// Test script to understand Request object header handling
const request1 = new Request('https://example.com', {
  headers: { 'origin': 'https://malicious.com' }
});

console.log('Test 1: Request with custom origin header');
console.log('  Request URL:', request1.url);
console.log('  Origin header:', request1.headers.get('origin'));

const request2 = new Request('https://example.com', {
  headers: { 'referer': 'https://malicious.com/page' }
});

console.log('\nTest 2: Request with custom referer header');
console.log('  Request URL:', request2.url);
console.log('  Referer header:', request2.headers.get('referer'));
