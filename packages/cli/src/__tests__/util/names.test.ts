/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect } from 'vitest'
import {
	MAX_NAME_LENGTH,
	isConfinedPath,
	isDeviceName,
	isOrigin,
	isSafeCspSource,
	isSafeHeaderValue,
	isSafeSegment,
	validateAppPath,
	validateDirArgument,
	validateExposeSource,
	validateName,
} from '../../util/names.js'

/*
 *   VALIDATE NAME
 ***************************************************************************************************/
describe('validateName', () => {
	it('accepts lowercase, digits and single hyphens', () => {
		for (const name of ['acme', 'dashboard', 'acme-frontend', 'app1', 'a']) {
			expect(validateName(name)).toBeUndefined()
		}
	})

	it('rejects empty, spaces, slashes, traversal, uppercase and leading digits', () => {
		for (const name of ['', '  ', 'Bad', 'a b', 'a/b', '../x', '..', '1app', '-x', 'x-']) {
			expect(validateName(name)).toBeDefined()
		}
	})

	it('rejects Windows device names, on every OS', () => {
		for (const name of ['con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9']) {
			expect(validateName(name)).toMatch(/device name/)
		}
	})

	it('rejects an upper case device name too', () => {
		expect(validateName('CON')).toBeDefined()
	})

	it('accepts names that only look like device names', () => {
		for (const name of ['console', 'com10', 'lpt', 'auxiliary', 'null', 'my-con']) {
			expect(validateName(name)).toBeUndefined()
		}
	})

	it('rejects the name of a shared package, built in or listed by the workspace', () => {
		for (const name of ['react', 'react-dom', 'vue', 'svelte', 'vite']) {
			expect(validateName(name)).toMatch(/shared package/)
		}

		expect(validateName('lodash')).toBeUndefined()
		expect(validateName('lodash', 'app name', { shared: ['lodash'] })).toMatch(/shared package/)
	})

	it('allows names up to the length limit and no further', () => {
		expect(validateName('a'.repeat(MAX_NAME_LENGTH))).toBeUndefined()
		expect(validateName('a'.repeat(MAX_NAME_LENGTH + 1))).toMatch(/at most 64/)
	})

	it('labels the offending value in the message', () => {
		expect(validateName('Bad Name', 'app name')).toContain('Invalid app name')
	})
})

describe('isDeviceName', () => {
	it('matches a device with any extension and the superscript forms', () => {
		for (const segment of ['con', 'CON.txt', 'aux.tar.gz', 'COM¹', 'lpt³', 'conin$', 'nul.']) {
			expect(isDeviceName(segment)).toBe(true)
		}
		for (const segment of ['connect', 'com', 'a.con', 'lpt10']) {
			expect(isDeviceName(segment)).toBe(false)
		}
	})
})

/*
 *   PATHS
 ***************************************************************************************************/
describe('isConfinedPath', () => {
	it('accepts relative paths that stay inside', () => {
		for (const path of ['apps/shell', './src/app.tsx', 'a', 'a\\b', 'a/./b']) {
			expect(isConfinedPath(path)).toBe(true)
		}
	})

	it('rejects empty, absolute, UNC, drive and drive-relative paths', () => {
		for (const path of [
			'',
			'/etc',
			'\\evil',
			'\\\\server\\share',
			'//server/share',
			'C:\\x',
			'C:/x',
			'C:foo',
			'c:',
		]) {
			expect(isConfinedPath(path)).toBe(false)
		}
	})

	it('rejects ":" anywhere, since "a:b" is an NTFS alternate data stream', () => {
		expect(isConfinedPath('apps/shell:stream')).toBe(false)
		expect(isConfinedPath('apps/shell::$DATA')).toBe(false)
	})

	it('rejects ".." in either slash style, and control characters', () => {
		for (const path of ['..', '../x', 'a/../b', 'a\\..\\b', 'a/..', 'a\u0000b', 'a\nb']) {
			expect(isConfinedPath(path)).toBe(false)
		}
	})
})

describe('isSafeSegment', () => {
	it('rejects "..", devices, trailing dots and spaces, and forbidden characters', () => {
		for (const segment of [
			'',
			'..',
			'con',
			'aux.txt',
			'a.',
			'a ',
			'a:b',
			'a<b',
			'a|b',
			'a*',
			'a?',
		]) {
			expect(isSafeSegment(segment)).toBe(false)
		}
		for (const segment of ['.', 'src', 'My App', '.config', 'a.b']) {
			expect(isSafeSegment(segment)).toBe(true)
		}
	})
})

describe('validateAppPath', () => {
	it('accepts lowercase folder paths', () => {
		for (const path of ['apps/shell', 'packages/web/shell', 'a', 'apps/v1.2', 'apps/my_app']) {
			expect(validateAppPath(path)).toBeUndefined()
		}
	})

	it('rejects everything that is not one', () => {
		for (const path of [
			'',
			'.',
			'..',
			'../x',
			'/abs',
			'C:foo',
			'\\\\server\\share',
			'apps/shell/',
			'apps//shell',
			'Apps/Shell',
			'apps/con',
			'apps/shell:s',
		]) {
			expect(validateAppPath(path)).toBeDefined()
		}
	})
})

describe('validateExposeSource', () => {
	it('accepts relative module paths', () => {
		for (const source of ['./src/app/app.tsx', 'src/App.vue', './src/Widget.svelte']) {
			expect(validateExposeSource(source)).toBeUndefined()
		}
	})

	it('rejects escapes, absolute paths and devices', () => {
		for (const source of [
			'../x.tsx',
			'/x.tsx',
			'C:x.tsx',
			'./src/../../x.tsx',
			'./src/nul/x.tsx',
			'',
		]) {
			expect(validateExposeSource(source)).toBeDefined()
		}
	})
})

describe('validateDirArgument', () => {
	it('accepts a folder name, a nested relative path and an absolute one', () => {
		for (const dir of [
			'acme',
			'projects/acme',
			'./acme',
			'.',
			'C:\\work\\acme',
			'/home/me/acme',
		]) {
			expect(validateDirArgument(dir)).toBeUndefined()
		}
	})

	it('rejects parent folders', () => {
		for (const dir of ['..', '../esc', 'a/../../esc', '..\\esc']) {
			expect(validateDirArgument(dir)).toMatch(/not allowed/)
		}
	})

	it('rejects device segments, in any folder', () => {
		for (const dir of ['con', 'work/nul', 'aux.txt', 'C:\\work\\com1']) {
			expect(validateDirArgument(dir)).toMatch(/not allowed/)
		}
	})

	it('rejects UNC and device paths, drive-relative paths and control characters', () => {
		for (const dir of [
			'\\\\server\\share\\x',
			'//server/share',
			'\\\\?\\C:\\x',
			'C:foo',
			'a\u0000b',
			'',
		]) {
			expect(validateDirArgument(dir)).toBeDefined()
		}
	})
})

/*
 *   HEADERS AND ORIGINS
 ***************************************************************************************************/
describe('isSafeHeaderValue', () => {
	it('allows one line, with tabs', () => {
		expect(isSafeHeaderValue("default-src 'self'; img-src data:")).toBe(true)
		expect(isSafeHeaderValue('a\tb')).toBe(true)
	})

	it('rejects CR, LF and other control characters', () => {
		for (const value of ['a\nb', 'a\rb', 'a\r\nSet-Cookie: x=1', 'a\u0000b', 'a\u007fb']) {
			expect(isSafeHeaderValue(value)).toBe(false)
		}
	})
})

describe('isSafeCspSource', () => {
	it('accepts one source', () => {
		for (const source of ["'self'", 'https://a.example.com', 'https://*.example.com', 'edge']) {
			expect(isSafeCspSource(source)).toBe(true)
		}
	})

	it('rejects whitespace, semicolons and commas', () => {
		for (const source of ['', 'a b', 'a;b', 'a,b', 'a\nb']) {
			expect(isSafeCspSource(source)).toBe(false)
		}
	})
})

describe('isOrigin', () => {
	it('accepts scheme, host and optional port', () => {
		for (const origin of ['https://a.test', 'http://localhost:5173', 'https://a.b.test:8443']) {
			expect(isOrigin(origin)).toBe(true)
		}
	})

	it('rejects paths, slashes, credentials, other schemes and plain hosts', () => {
		for (const origin of [
			'https://a.test/',
			'https://a.test/x',
			'https://a.test?x=1',
			'https://u:p@a.test',
			'ftp://a.test',
			'javascript:alert(1)',
			'a.test',
			'*',
			'',
		]) {
			expect(isOrigin(origin)).toBe(false)
		}
	})
})

/*
 *   UNTRIMMED NAMES AND TRAILING-DEVICE NAMES
 ***************************************************************************************************/
describe('names with spaces around them', () => {
	it.each([' dash', 'dash ', 'dash\t', 'dash\n', ' dash '])(
		'rejects %j instead of letting the caller use the untrimmed value',
		value => {
			expect(validateName(value)).toContain('spaces')
		},
	)

	it('still accepts the plain name', () => {
		expect(validateName('dash')).toBeUndefined()
	})
})

describe('device names with trailing spaces, dots and extensions', () => {
	it.each(['con .txt', 'aux .c', 'con\u00a0', 'nul.', 'com1 ', 'lpt1 . .txt', 'CON .TXT'])(
		'treats %j as a device',
		segment => {
			expect(isDeviceName(segment)).toBe(true)
			expect(isSafeSegment(segment)).toBe(false)
		},
	)

	it.each(['console', 'con-x', 'conf.txt', 'communal', 'auxiliary'])(
		'does not mistake %j for one',
		segment => {
			expect(isDeviceName(segment)).toBe(false)
		},
	)

	it('rejects them in a directory argument', () => {
		expect(validateDirArgument('con .txt/x')).toBeDefined()
		expect(validateDirArgument(String.raw`sub\aux .c`)).toBeDefined()
	})
})
