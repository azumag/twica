Fixed CSRF test failures by using spies to simulate forbidden headers.

The issue was that 'origin' and 'referer' headers are forbidden header names in the Fetch API specification and cannot be set programmatically on Request objects. When tests tried to set these headers directly, they were stripped to null.

Solution: Used vi.spyOn() to mock the request.headers.get() method, allowing tests to simulate forbidden header values and properly test the CSRF validation logic.

Changes:
- Modified 'should reject invalid origin header' test to use spy
- Modified 'should reject invalid referer header when origin is missing' test to use spy
- Fixed property name assertion to match actual code
- Added proper spy cleanup with mockRestore()

All 146 tests now passing (100% pass rate).
