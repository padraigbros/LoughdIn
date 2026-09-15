/**
 * Mounts the real app over a stub Supabase client, in a jsdom document built
 * from the real index.html. Shared by the tests that drive the app as a whole
 * rather than one of its pure functions.
 */

import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {JSDOM} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';
import {build} from 'esbuild';
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let mounts = 0;

// The signed-out journey is all client calls, so the app is mounted over a
// stub Supabase client and the replies are set per test.
export function stubClient(replies = {}, session = null) {
  const calls = [];
  const record = (name, fallback) => async (...args) => {
    calls.push({name, args});
    return (replies[name] ? await replies[name](...args) : fallback);
  };
  return {
    calls,
    // Signed in, sync starts for real, so the account dialog needs a transport
    // that answers rather than one that throws under every button.
    rpc: async name => ({
      data: name === 'pull_changes' ? {changes: [], cursor: 0, epoch: 1} : {outcome: 'applied'},
      error: null,
    }),
    auth: {
      onAuthStateChange: () => ({data: {subscription: {unsubscribe() {}}}}),
      getSession: async () => ({data: {session}, error: null}),
      stopAutoRefresh() {},
      signInWithPassword: record('signInWithPassword', {data: {session: {}}, error: null}),
      signUp: record('signUp', {data: {session: null, user: {}}, error: null}),
      resend: record('resend', {error: null}),
      resetPasswordForEmail: record('resetPasswordForEmail', {error: null}),
      signInWithOAuth: record('signInWithOAuth', {data: {}, error: null}),
      signInWithIdToken: record('signInWithIdToken', {data: {session: {}}, error: null}),
      signOut: record('signOut', {error: null}),
    },
  };
}

/**
 * A service worker container the test drives by hand. jsdom has none, and the
 * update path is all about which of install, waiting and claiming happened, so
 * each of those is a call the test makes rather than a state it waits for.
 */
export function stubServiceWorker({waiting = false, controlled = true} = {}) {
  const posted = [];
  const containerListeners = {};
  const registrationListeners = {};
  const workerListeners = {};
  const waitingWorker = {postMessage: message => posted.push(message)};
  const registration = {
    waiting: waiting ? waitingWorker : null,
    installing: null,
    addEventListener: (type, fn) => { (registrationListeners[type] ||= []).push(fn); },
  };
  const container = {
    controller: controlled ? {} : null,
    register: async () => registration,
    addEventListener: (type, fn) => { (containerListeners[type] ||= []).push(fn); },
  };
  const fire = (listeners, type) => [...(listeners[type] || [])].forEach(fn => fn());
  return {
    container, registration, posted,
    /** The browser finding, downloading and parking a new worker. */
    installUpdate() {
      registration.installing = {addEventListener: (type, fn) => { (workerListeners[type] ||= []).push(fn); }};
      fire(registrationListeners, 'updatefound');
      registration.waiting = waitingWorker;
      registration.installing = null;
      fire(workerListeners, 'statechange');
    },
    /** The waiting worker taking over, which is what a reload follows. */
    claim() { registration.waiting = null; fire(containerListeners, 'controllerchange'); },
  };
}

/**
 * The functions app.js imports from vendor/native.js, recording each call. The
 * lifecycle listener is kept so a test can bring the app back to the
 * foreground, and permission is granted unless the test says otherwise.
 */
export function stubNative({permission = true} = {}) {
  const calls = [];
  let onResume = null;
  const record = (name, reply) => async (...args) => { calls.push({name, args}); return reply; };
  return {
    calls,
    named: name => calls.filter(call => call.name === name),
    /** Android reporting the activity active again (appStateChange, isActive). */
    resume: () => onResume(),
    isNativeApp: () => { calls.push({name: 'isNativeApp', args: []}); return true; },
    registerNativeLifecycle: async options => {
      calls.push({name: 'registerNativeLifecycle', args: [options]});
      onResume = options.onResume;
      return {remove: async () => { calls.push({name: 'removeLifecycle', args: []}); }};
    },
    requestLocalNotificationPermission: record('requestLocalNotificationPermission', permission),
    scheduleSessionNotification: record('scheduleSessionNotification', true),
    cancelSessionNotification: record('cancelSessionNotification', undefined),
    signInWithGoogleNative: record('signInWithGoogleNative', {idToken: 'stub-google-id-token', nonce: 'stub-raw-nonce'}),
  };
}

const NATIVE_EXPORTS = ['isNativeApp', 'registerNativeLifecycle', 'requestLocalNotificationPermission',
  'scheduleSessionNotification', 'cancelSessionNotification', 'signInWithGoogleNative'];

/**
 * `native` supplies the functions app.js imports from vendor/native.js, and by
 * default also marks the page as running inside Capacitor. Passing
 * `nativePlatform: false` keeps the stub reachable on a plain website, so a
 * test can prove the website never loads or calls it.
 */
export async function mount(client, {serviceWorker = null, native = null, nativePlatform = !!native} = {}) {
  const dom = new JSDOM(await readFile(new URL('../../index.html', import.meta.url), 'utf8'),
    {url: 'https://app.example.test/LoughdIn/', pretendToBeVisual: true});
  if (serviceWorker) {
    Object.defineProperty(dom.window.navigator, 'serviceWorker', {value: serviceWorker, configurable: true});
  }
  if (nativePlatform) dom.window.Capacitor = {isNativePlatform: () => true};
  globalThis.__stubNative = native;
  // jsdom refuses to navigate and will not let reload be redefined, so the app
  // is given a stand-in global to call. A reload is exactly what these tests
  // count, since it is how a taken update becomes visible.
  const reloads = [];
  const realLocation = dom.window.location;
  const location = {
    get href() { return realLocation.href; },
    get origin() { return realLocation.origin; },
    get pathname() { return realLocation.pathname; },
    get search() { return realLocation.search; },
    get hash() { return realLocation.hash; },
    toString: () => realLocation.href,
    reload: () => reloads.push(realLocation.href),
  };
  const originals = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    location, localStorage: dom.window.localStorage, Option: dom.window.Option,
    indexedDB: new IDBFactory(), BroadcastChannel: undefined,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
  }
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new dom.window.Event('close'));
  };
  const bundle = await build({
    absWorkingDir: appRoot, entryPoints: ['src/app.js'], bundle: true, write: false,
    format: 'esm', platform: 'browser', target: 'es2022',
    plugins: [{
      name: 'account-fixture',
      setup(builder) {
        builder.onResolve({filter: /config\.js$/}, () => ({path: 'config', namespace: 'fixture'}));
        builder.onResolve({filter: /vendor\/supabase\.js$/}, () => ({path: 'supabase', namespace: 'fixture'}));
        builder.onResolve({filter: /vendor\/native\.js$/}, () => ({path: 'native', namespace: 'fixture'}));
        builder.onLoad({filter: /.*/, namespace: 'fixture'}, args => ({
          contents: {
            config: "export const SUPABASE_URL='https://stub.test';export const SUPABASE_PUBLISHABLE_KEY='stub-key';export const GOOGLE_WEB_CLIENT_ID='stub-web-client.apps.googleusercontent.com';",
            supabase: 'export const createClient=()=>globalThis.__stubClient;',
            // Evaluated only when imported, so the website path records nothing.
            // Hand-written stubs without a call log (e.g. Google sign-in tests) are fine too.
            native: "globalThis.__stubNative?.calls?.push({name:'import',args:[]});"
              + NATIVE_EXPORTS.map(name => `export const ${name}=(...args)=>globalThis.__stubNative.${name}(...args);`).join(''),
          }[args.path],
          loader: 'js',
        }));
      },
    }],
  });
  globalThis.__stubClient = client;
  // Identical sources would resolve to one data: URL and Node would hand back
  // the cached module, so the second mount would never build its own DOM.
  const source = bundle.outputFiles[0].text + `\n//${mounts++}\n`;
  const app = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  return {
    app,
    window: dom.window,
    reloads,
    /** Somebody starting to use the page, rather than having just arrived at it. */
    touch() {
      dom.window.document.dispatchEvent(new dom.window.Event('pointerdown', {bubbles: true}));
    },
    /** Switching away from the page, which jsdom has no way to do on its own. */
    hide(hidden = true) {
      Object.defineProperty(dom.window.document, 'hidden', {value: hidden, configurable: true});
      dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
    },
    async dispose() {
      await app.disposeApp();
      dom.window.close();
      delete globalThis.__stubClient;
      delete globalThis.__stubNative;
      for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key];
      }
    },
  };
}

export const settle = () => new Promise(resolve => setTimeout(resolve, 0));
