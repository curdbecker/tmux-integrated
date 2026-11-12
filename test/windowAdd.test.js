/**
 * Tests for windows that are added to the session while the extension is
 * connected.
 *
 * A window another tmux client creates (a script's `tmux new-window`, a plain
 * `tmux attach` beside VS Code) gets a tab of its own, without being shown.
 * tmux reports the windows our own terminals create in the same way, and such
 * a report may be handled before the terminal has attached its window: those
 * must never get a second tab.
 */
const assert = require('node:assert/strict');
const events = require('node:events');
const Module = require('node:module');
const test = require('node:test');

class Disposable {
  dispose() {}
}

class EventEmitter {
  constructor() {
    this.emitter = new events.EventEmitter();
    this.event = (listener) => {
      this.emitter.on('event', listener);
      return new Disposable();
    };
  }

  fire(value) {
    this.emitter.emit('event', value);
  }
}

const BOOTSTRAP = { id: '@1', paneId: '%1', index: 0, name: 'tmux:0', automaticRename: true };

/** Lets every pending promise continuation and immediate run. */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Activates a fresh copy of the extension against a fake tmux client and
 * connects it by asking for a terminal profile, which takes the session's
 * bootstrap window.
 */
async function connectExtension(t) {
  const state = { client: null, windows: [BOOTSTRAP], created: [], shown: 0 };

  class FakeTmuxControlClient extends events.EventEmitter {
    constructor() {
      super();
      state.client = this;
      /** Runs inside newWindow(), before it answers. */
      this.beforeNewWindowAnswers = () => {};
    }

    setVersion() {}
    versionAtLeast() { return true; }
    isConnected() { return true; }
    async connect() {}
    async listWindows() { return state.windows; }
    async sendCommand(command) { return command.includes('__ping__') ? ['__ping__'] : []; }
    async sendCommandList(commands) { return commands.map(() => []); }
    async updateEnvironment() {}

    async newWindow() {
      const created = { id: '@9', paneId: '%9', index: 3, name: 'bash', automaticRename: true };
      state.windows = [...state.windows, created];
      this.beforeNewWindowAnswers();
      return { windowId: created.id, paneId: created.paneId, windowIndex: created.index };
    }

    async getWindowIndex() { return 3; }
    async getWindowName() { return 'tmux:3'; }
    async getWindowAutomaticRename() { return true; }
    async resizeWindowForClient() {}
    async capturePane() { return ''; }
    async getPaneCursor() { return { x: 0, y: 0 }; }
    removePaneDecoder() {}
  }

  let profileProvider;
  const vscode = {
    Disposable,
    EventEmitter,
    StatusBarAlignment: { Left: 1 },
    TerminalExitReason: { Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 },
    TerminalProfile: class {
      constructor(options) {
        this.options = options;
      }
    },
    Uri: { parse: (value) => ({ value }) },
    env: { appRoot: '/mock/vscode', openExternal() {} },
    workspace: {
      workspaceFolders: [{ name: 'project', index: 0, uri: { fsPath: '/workspace/project' } }],
      getConfiguration(section) {
        return {
          get(key, fallback) {
            return section === 'tmux-integrated' && key === 'autoConnect' ? false : fallback;
          },
        };
      },
    },
    window: {
      terminals: [],
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, dispose() {}, text: '', command: '' }),
      registerTerminalProfileProvider(_id, provider) {
        profileProvider = provider;
        return new Disposable();
      },
      createTerminal(options) {
        state.created.push(options);
        return { show() { state.shown++; } };
      },
      showErrorMessage: async () => undefined,
      showWarningMessage() {},
      onDidOpenTerminal: () => new Disposable(),
      onDidCloseTerminal: () => new Disposable(),
      onDidChangeActiveTerminal: () => new Disposable(),
    },
    commands: { registerCommand: () => new Disposable() },
  };

  const originalLoad = Module._load;
  Module._load = function loadMockedModule(request, parent, isMain) {
    if (request === 'vscode') {
      return vscode;
    }
    if (request === 'child_process') {
      return {
        execFileSync(_file, args) {
          if (args[0] === '-V') {
            return 'tmux 3.5a\n';
          }
          if (args[0] === 'has-session') {
            throw new Error('missing session');
          }
          return '';
        },
      };
    }
    if (request.endsWith('/tmuxControlClient') || request === './tmuxControlClient') {
      return {
        TmuxControlClient: FakeTmuxControlClient,
        CommandFlags: { None: 0, TolerateErrors: 1 },
        shellescape: (value) => value,
      };
    }
    return originalLoad(request, parent, isMain);
  };
  const loaded = ['../out/extension.js', '../out/tmuxTerminalProvider.js'];
  t.after(() => {
    Module._load = originalLoad;
    for (const file of loaded) {
      delete require.cache[require.resolve(file)];
    }
  });

  const extension = require('../out/extension.js');
  await extension.activate({
    extensionPath: '/extension',
    globalStorageUri: { fsPath: '/extension-storage' },
    subscriptions: [],
  });
  const first = await profileProvider.provideTerminalProfile({ isCancellationRequested: false });
  assert.ok(state.client, 'the extension connected');
  return { state, profileProvider, bootstrapPty: first.options.pty };
}

test('a window another client creates gets a tab that is not shown', async (t) => {
  const { state } = await connectExtension(t);
  state.windows = [BOOTSTRAP, { id: '@5', paneId: '%5', index: 1, name: 'build', automaticRename: false }];

  state.client.emit('window-add', '@5');
  await settle();

  assert.equal(state.created.length, 1);
  assert.deepEqual(state.created[0].pty.existingWindow, {
    windowId: '@5',
    paneId: '%5',
    windowIndex: 1,
    name: 'build',
    automaticRename: false,
  });
  assert.equal(state.shown, 0);
});

test('a window that is gone again before it is adopted gets no tab', async (t) => {
  const { state } = await connectExtension(t);

  state.client.emit('window-add', '@5');
  await settle();

  assert.equal(state.created.length, 0);
});

test('a window a terminal of ours has attached gets no second tab', async (t) => {
  const { state, bootstrapPty } = await connectExtension(t);
  t.after(() => bootstrapPty.close());
  await bootstrapPty.open(undefined);
  assert.equal(bootstrapPty.getAttachedTmuxWindowId(), BOOTSTRAP.id);

  state.client.emit('window-add', BOOTSTRAP.id);
  await settle();

  assert.equal(state.created.length, 0);
});

test('a window our own terminal creates gets no second tab', async (t) => {
  const { state, profileProvider } = await connectExtension(t);
  const profile = await profileProvider.provideTerminalProfile({ isCancellationRequested: false });
  const pty = profile.options.pty;
  assert.equal(pty.existingWindow, null, 'the terminal creates its window');
  t.after(() => pty.close());
  // The report of the new window is handled before new-window has answered,
  // so well before the terminal has attached the window.
  state.client.beforeNewWindowAnswers = () => state.client.emit('window-add', '@9');

  await pty.open(undefined);
  await settle();

  assert.equal(pty.getAttachedTmuxWindowId(), '@9');
  assert.equal(state.created.length, 0);
});

test('a window whose creation by our own terminal failed is adopted like any other', async (t) => {
  const { state, profileProvider } = await connectExtension(t);
  const profile = await profileProvider.provideTerminalProfile({ isCancellationRequested: false });
  const pty = profile.options.pty;
  state.client.newWindow = async () => {
    state.windows = [BOOTSTRAP, { id: '@9', paneId: '%9', index: 3, name: 'bash', automaticRename: true }];
    state.client.emit('window-add', '@9');
    throw new Error('the answer was lost');
  };

  await pty.open(undefined);
  await settle();

  assert.equal(state.created.length, 1);
  assert.equal(state.created[0].pty.existingWindow.windowId, '@9');
});
