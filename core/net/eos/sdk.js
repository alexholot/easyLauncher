'use strict';
// Мост к Epic Online Services (EOS SDK, библиотека на C) через koffi — без компиляции.
// Используется только то, что нужно для игры с друзьями без своего сервера:
//   Connect — вход по устройству (аккаунт Epic не нужен, у каждого ПК свой EOS-идентификатор);
//   P2P     — пакеты между игроками: напрямую, а если роутер не пускает — через ретрансляторы Epic.
// Все обратные вызовы EOS приходят внутри EOS_Platform_Tick, то есть в основном потоке Node.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// Коды результатов (eos_result.h)
const R = { Success: 0, InvalidUser: 3, NotFound: 18, LimitExceeded: 22, DuplicateNotAllowed: 24, AlreadyConfigured: 14 };
const SOCKET = 'easylauncher';
// Типы соединения из EOS_ENetworkConnectionType
const ROUTE = { 1: 'eos-direct', 2: 'eos-relay' };
const CLOSED = { 0: 'неизвестная причина', 1: 'закрыто этим ПК', 2: 'закрыто другом', 3: 'нет ответа', 4: 'слишком много соединений', 7: 'соединиться не удалось', 8: 'соединение закрыто', 9: 'не удалось договориться о соединении', 10: 'внутренняя ошибка' };

let api = null; // загруженная DLL и типы — одна на процесс

/** Загрузить EOS SDK. dll — путь к EOSSDK-Win64-Shipping.dll. */
function load(dll) {
  if (api) return api;
  const koffi = require('koffi');
  const lib = koffi.load(dll);
  const T = {};
  T.InitializeOptions = koffi.struct('EOS_InitializeOptions', {
    ApiVersion: 'int32',
    AllocateMemoryFunction: 'void*',
    ReallocateMemoryFunction: 'void*',
    ReleaseMemoryFunction: 'void*',
    ProductName: 'const char*',
    ProductVersion: 'const char*',
    Reserved: 'void*',
    SystemInitializeOptions: 'void*',
    OverrideThreadAffinity: 'void*',
  });
  T.ClientCredentials = koffi.struct('EOS_Platform_ClientCredentials', { ClientId: 'const char*', ClientSecret: 'const char*' });
  T.PlatformOptions = koffi.struct('EOS_Platform_Options', {
    ApiVersion: 'int32',
    Reserved: 'void*',
    ProductId: 'const char*',
    SandboxId: 'const char*',
    ClientCredentials: T.ClientCredentials,
    bIsServer: 'int32',
    EncryptionKey: 'const char*',
    OverrideCountryCode: 'const char*',
    OverrideLocaleCode: 'const char*',
    DeploymentId: 'const char*',
    Flags: 'uint64',
    CacheDirectory: 'const char*',
    TickBudgetInMilliseconds: 'uint32',
    RTCOptions: 'void*',
    IntegratedPlatformOptionsContainerHandle: 'void*',
    SystemSpecificOptions: 'void*',
    TaskNetworkTimeoutSeconds: 'void*',
  });
  T.Credentials = koffi.struct('EOS_Connect_Credentials', { ApiVersion: 'int32', Token: 'const char*', Type: 'int32' });
  T.UserLoginInfo = koffi.struct('EOS_Connect_UserLoginInfo', { ApiVersion: 'int32', DisplayName: 'const char*', NsaIdToken: 'const char*' });
  T.LoginOptions = koffi.struct('EOS_Connect_LoginOptions', { ApiVersion: 'int32', Credentials: koffi.pointer(T.Credentials), UserLoginInfo: koffi.pointer(T.UserLoginInfo) });
  T.LoginInfo = koffi.struct('EOS_Connect_LoginCallbackInfo', { ResultCode: 'int32', ClientData: 'void*', LocalUserId: 'void*', ContinuanceToken: 'void*' });
  T.CreateUserOptions = koffi.struct('EOS_Connect_CreateUserOptions', { ApiVersion: 'int32', ContinuanceToken: 'void*' });
  T.CreateUserInfo = koffi.struct('EOS_Connect_CreateUserCallbackInfo', { ResultCode: 'int32', ClientData: 'void*', LocalUserId: 'void*' });
  T.CreateDeviceIdOptions = koffi.struct('EOS_Connect_CreateDeviceIdOptions', { ApiVersion: 'int32', DeviceModel: 'const char*' });
  T.DeleteDeviceIdOptions = koffi.struct('EOS_Connect_DeleteDeviceIdOptions', { ApiVersion: 'int32' });
  T.ResultInfo = koffi.struct('EOS_ResultOnlyCallbackInfo', { ResultCode: 'int32', ClientData: 'void*' });
  T.ApiOnly = koffi.struct('EOS_ApiOnlyOptions', { ApiVersion: 'int32' });
  T.AuthExpInfo = koffi.struct('EOS_Connect_AuthExpirationCallbackInfo', { ClientData: 'void*', LocalUserId: 'void*' });
  T.SocketId = koffi.struct('EOS_P2P_SocketId', { ApiVersion: 'int32', SocketName: 'char[33]' });
  T.SendOptions = koffi.struct('EOS_P2P_SendPacketOptions', {
    ApiVersion: 'int32',
    LocalUserId: 'void*',
    RemoteUserId: 'void*',
    SocketId: 'void*',
    Channel: 'uint8',
    DataLengthBytes: 'uint32',
    Data: 'void*',
    bAllowDelayedDelivery: 'int32',
    Reliability: 'int32',
    bDisableAutoAcceptConnection: 'int32',
  });
  T.NextSizeOptions = koffi.struct('EOS_P2P_GetNextReceivedPacketSizeOptions', { ApiVersion: 'int32', LocalUserId: 'void*', RequestedChannel: 'void*' });
  T.ReceiveOptions = koffi.struct('EOS_P2P_ReceivePacketOptions', { ApiVersion: 'int32', LocalUserId: 'void*', MaxDataSizeBytes: 'uint32', RequestedChannel: 'void*' });
  T.NotifyOptions = koffi.struct('EOS_P2P_AddNotifyPeerOptions', { ApiVersion: 'int32', LocalUserId: 'void*', SocketId: 'void*' });
  T.PeerOptions = koffi.struct('EOS_P2P_PeerOptions', { ApiVersion: 'int32', LocalUserId: 'void*', RemoteUserId: 'void*', SocketId: 'void*' });
  T.RequestInfo = koffi.struct('EOS_P2P_OnIncomingConnectionRequestInfo', { ClientData: 'void*', LocalUserId: 'void*', RemoteUserId: 'void*', SocketId: 'void*' });
  T.EstablishedInfo = koffi.struct('EOS_P2P_OnPeerConnectionEstablishedInfo', { ClientData: 'void*', LocalUserId: 'void*', RemoteUserId: 'void*', SocketId: 'void*', ConnectionType: 'int32', NetworkType: 'int32' });
  T.ClosedInfo = koffi.struct('EOS_P2P_OnRemoteConnectionClosedInfo', { ClientData: 'void*', LocalUserId: 'void*', RemoteUserId: 'void*', SocketId: 'void*', Reason: 'int32' });
  T.QueueSizeOptions = koffi.struct('EOS_P2P_SetPacketQueueSizeOptions', { ApiVersion: 'int32', IncomingPacketQueueMaxSizeBytes: 'uint64', OutgoingPacketQueueMaxSizeBytes: 'uint64' });
  T.RelayOptions = koffi.struct('EOS_P2P_SetRelayControlOptions', { ApiVersion: 'int32', RelayControl: 'int32' });
  T.NatInfo = koffi.struct('EOS_P2P_OnQueryNATTypeCompleteInfo', { ResultCode: 'int32', ClientData: 'void*', NATType: 'int32' });

  // все обратные вызовы — с указателем на структуру; разбираем его сами (koffi.decode)
  const cb = (name) => koffi.pointer(koffi.proto(`void ${name}(void *Data)`));
  const CB = { login: cb('EOS_OnLogin'), createUser: cb('EOS_OnCreateUser'), result: cb('EOS_OnResult'), authExp: cb('EOS_OnAuthExpiration'), request: cb('EOS_OnRequest'), established: cb('EOS_OnEstablished'), closed: cb('EOS_OnClosed'), nat: cb('EOS_OnNat') };

  const F = {
    Initialize: lib.func('int32 EOS_Initialize(const EOS_InitializeOptions *Options)'),
    PlatformCreate: lib.func('void *EOS_Platform_Create(const EOS_Platform_Options *Options)'),
    PlatformTick: lib.func('void EOS_Platform_Tick(void *Handle)'),
    PlatformRelease: lib.func('void EOS_Platform_Release(void *Handle)'),
    GetConnect: lib.func('void *EOS_Platform_GetConnectInterface(void *Handle)'),
    GetP2P: lib.func('void *EOS_Platform_GetP2PInterface(void *Handle)'),
    ResultToString: lib.func('const char *EOS_EResult_ToString(int32 Result)'),
    IdToString: lib.func('int32 EOS_ProductUserId_ToString(void *Id, uint8_t *OutBuffer, _Inout_ int32_t *InOutBufferLength)'),
    IdFromString: lib.func('void *EOS_ProductUserId_FromString(const char *Str)'),
    CreateDeviceId: lib.func('void EOS_Connect_CreateDeviceId(void *Handle, const EOS_Connect_CreateDeviceIdOptions *Options, void *ClientData, EOS_OnResult *Cb)'),
    DeleteDeviceId: lib.func('void EOS_Connect_DeleteDeviceId(void *Handle, const EOS_Connect_DeleteDeviceIdOptions *Options, void *ClientData, EOS_OnResult *Cb)'),
    Login: lib.func('void EOS_Connect_Login(void *Handle, const EOS_Connect_LoginOptions *Options, void *ClientData, EOS_OnLogin *Cb)'),
    CreateUser: lib.func('void EOS_Connect_CreateUser(void *Handle, const EOS_Connect_CreateUserOptions *Options, void *ClientData, EOS_OnCreateUser *Cb)'),
    AddNotifyAuthExpiration: lib.func('uint64 EOS_Connect_AddNotifyAuthExpiration(void *Handle, const EOS_ApiOnlyOptions *Options, void *ClientData, EOS_OnAuthExpiration *Cb)'),
    SendPacket: lib.func('int32 EOS_P2P_SendPacket(void *Handle, const EOS_P2P_SendPacketOptions *Options)'),
    NextSize: lib.func('int32 EOS_P2P_GetNextReceivedPacketSize(void *Handle, const EOS_P2P_GetNextReceivedPacketSizeOptions *Options, _Out_ uint32_t *OutSize)'),
    Receive: lib.func('int32 EOS_P2P_ReceivePacket(void *Handle, const EOS_P2P_ReceivePacketOptions *Options, _Out_ void **OutPeerId, void *OutSocketId, _Out_ uint8_t *OutChannel, void *OutData, _Out_ uint32_t *OutBytesWritten)'),
    AddNotifyRequest: lib.func('uint64 EOS_P2P_AddNotifyPeerConnectionRequest(void *Handle, const EOS_P2P_AddNotifyPeerOptions *Options, void *ClientData, EOS_OnRequest *Cb)'),
    AddNotifyEstablished: lib.func('uint64 EOS_P2P_AddNotifyPeerConnectionEstablished(void *Handle, const EOS_P2P_AddNotifyPeerOptions *Options, void *ClientData, EOS_OnEstablished *Cb)'),
    AddNotifyClosed: lib.func('uint64 EOS_P2P_AddNotifyPeerConnectionClosed(void *Handle, const EOS_P2P_AddNotifyPeerOptions *Options, void *ClientData, EOS_OnClosed *Cb)'),
    Accept: lib.func('int32 EOS_P2P_AcceptConnection(void *Handle, const EOS_P2P_PeerOptions *Options)'),
    Close: lib.func('int32 EOS_P2P_CloseConnection(void *Handle, const EOS_P2P_PeerOptions *Options)'),
    SetQueueSize: lib.func('int32 EOS_P2P_SetPacketQueueSize(void *Handle, const EOS_P2P_SetPacketQueueSizeOptions *Options)'),
    SetRelay: lib.func('int32 EOS_P2P_SetRelayControl(void *Handle, const EOS_P2P_SetRelayControlOptions *Options)'),
    QueryNAT: lib.func('void EOS_P2P_QueryNATType(void *Handle, const EOS_ApiOnlyOptions *Options, void *ClientData, EOS_OnNat *Cb)'),
  };
  api = { koffi, T, CB, F };
  return api;
}

const fail = (what, code) => Object.assign(new Error(`EOS: ${what} — ${api.F.ResultToString(code)} (${code})`), { code: 'EOS', eos: code });

/**
 * Платформа EOS одного ПК: вход по устройству, затем P2P на сокете «easylauncher».
 * События: 'packet' (peerId, channel, Buffer), 'request' (peerId), 'established' (peerId, route),
 * 'closed' (peerId, причина), 'relogin'.
 */
class EosPlatform extends EventEmitter {
  /** opts: { dll, keys: {productId, sandboxId, deploymentId, clientId, clientSecret}, cacheDir, name } */
  constructor(opts) {
    super();
    this.opts = opts;
    this.puid = null;
    this.outbox = []; // {peer, channel, data} — пакеты, не влезшие в очередь EOS
    this.ids = new Map(); // строка → дескриптор EOS_ProductUserId
    this.refs = []; // зарегистрированные обратные вызовы (чтобы их не собрал сборщик мусора)
  }

  /** Загрузить SDK, создать платформу, войти по устройству. → puid (строка) */
  async start() {
    if (this.puid) return this.puid;
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => (this.starting = null));
    return this.starting;
  }

  async _start() {
    const { koffi, T, F } = load(this.opts.dll);
    this.api = api;
    const init = F.Initialize({ ApiVersion: 5, ProductName: 'easyLauncher', ProductVersion: this.opts.version || '1.0' });
    if (init !== R.Success && init !== R.AlreadyConfigured) throw fail('инициализация', init);
    const k = this.opts.keys;
    const cache = this.opts.cacheDir || path.join(os.tmpdir(), 'easylauncher-eos');
    fs.mkdirSync(cache, { recursive: true });
    this.platform = F.PlatformCreate({
      ApiVersion: 15,
      ProductId: k.productId,
      SandboxId: k.sandboxId,
      DeploymentId: k.deploymentId,
      ClientCredentials: { ClientId: k.clientId, ClientSecret: k.clientSecret },
      bIsServer: 0,
      // лаунчер — не игровое окно: оверлей Epic не нужен
      Flags: 0x2 | 0x4,
      CacheDirectory: cache,
      TickBudgetInMilliseconds: 0,
    });
    if (!this.platform) throw Object.assign(new Error('EOS: платформа не создалась — проверь ключи в eos.json.'), { code: 'EOS' });
    this.connect = F.GetConnect(this.platform);
    this.p2p = F.GetP2P(this.platform);
    this.timer = setInterval(() => this.tick(), 10);
    this.socket = koffi.alloc(T.SocketId, 1);
    koffi.encode(this.socket, T.SocketId, { ApiVersion: 1, SocketName: SOCKET });
    await this.login();
    // перед истечением входа EOS сообщает — входим заново тем же устройством
    F.AddNotifyAuthExpiration(this.connect, { ApiVersion: 1 }, null, this.register('authExp', () => this.login().then(() => this.emit('relogin')).catch((e) => this.emit('warning', e.message))));
    F.SetQueueSize(this.p2p, { ApiVersion: 1, IncomingPacketQueueMaxSizeBytes: 16 * 1024 * 1024, OutgoingPacketQueueMaxSizeBytes: 16 * 1024 * 1024 });
    F.SetRelay(this.p2p, { ApiVersion: 1, RelayControl: 1 }); // прямой путь, а если нельзя — ретранслятор Epic
    const note = { ApiVersion: 1, LocalUserId: this.local, SocketId: this.socket };
    F.AddNotifyRequest(this.p2p, note, null, this.register('request', (d) => this.emit('request', this.idString(koffi.decode(d, T.RequestInfo).RemoteUserId))));
    F.AddNotifyEstablished(
      this.p2p,
      note,
      null,
      this.register('established', (d) => {
        const i = koffi.decode(d, T.EstablishedInfo);
        this.emit('established', this.idString(i.RemoteUserId), ROUTE[i.NetworkType] || 'eos');
      }),
    );
    F.AddNotifyClosed(
      this.p2p,
      note,
      null,
      this.register('closed', (d) => {
        const i = koffi.decode(d, T.ClosedInfo);
        this.emit('closed', this.idString(i.RemoteUserId), CLOSED[i.Reason] || 'причина ' + i.Reason);
      }),
    );
    return this.puid;
  }

  register(kind, fn) {
    const p = api.koffi.register(fn, api.CB[kind]);
    this.refs.push(p);
    return p;
  }

  /** Обратный вызов, срабатывающий один раз: регистрация снимается после вызова. */
  once(kind, fn) {
    const p = api.koffi.register((d) => {
      // снимать регистрацию изнутри самого вызова нельзя — после него
      setImmediate(() => api.koffi.unregister(p));
      fn(d);
    }, api.CB[kind]);
    return p;
  }

  /** Вход по устройству: идентификатор устройства создаётся один раз; новый пользователь EOS — при первом входе. */
  async login() {
    const { koffi, T, F } = api;
    const made = await new Promise((resolve) => F.CreateDeviceId(this.connect, { ApiVersion: 1, DeviceModel: `${os.type()} ${os.arch()}` }, null, this.once('result', (d) => resolve(koffi.decode(d, T.ResultInfo).ResultCode))));
    if (made !== R.Success && made !== R.DuplicateNotAllowed) throw fail('создание идентификатора устройства', made);
    const res = await new Promise((resolve) =>
      F.Login(
        this.connect,
        { ApiVersion: 2, Credentials: { ApiVersion: 1, Token: null, Type: 10 }, UserLoginInfo: { ApiVersion: 2, DisplayName: (this.opts.name || 'Player').slice(0, 32), NsaIdToken: null } },
        null,
        this.once('login', (d) => resolve(koffi.decode(d, T.LoginInfo))),
      ),
    );
    let local = res.LocalUserId;
    if (res.ResultCode === R.InvalidUser) {
      const cu = await new Promise((resolve) => F.CreateUser(this.connect, { ApiVersion: 1, ContinuanceToken: res.ContinuanceToken }, null, this.once('createUser', (d) => resolve(koffi.decode(d, T.CreateUserInfo)))));
      if (cu.ResultCode !== R.Success) throw fail('создание пользователя', cu.ResultCode);
      local = cu.LocalUserId;
    } else if (res.ResultCode !== R.Success) throw fail('вход по устройству', res.ResultCode);
    this.local = local;
    this.puid = this.idString(local);
    return this.puid;
  }

  /** Только для проверки на одном ПК: новый идентификатор устройства → другой пользователь EOS. */
  async resetDevice() {
    const { koffi, T, F } = api;
    const code = await new Promise((resolve) => F.DeleteDeviceId(this.connect, { ApiVersion: 1 }, null, this.once('result', (d) => resolve(koffi.decode(d, T.ResultInfo).ResultCode))));
    if (code !== R.Success && code !== R.NotFound) throw fail('удаление идентификатора устройства', code);
  }

  idString(handle) {
    const buf = Buffer.alloc(40);
    const len = [buf.length];
    const r = api.F.IdToString(handle, buf, len);
    return r === R.Success ? buf.toString('utf8', 0, len[0] - 1).replace(/\0.*$/, '') : '';
  }

  idHandle(str) {
    if (!this.ids.has(str)) this.ids.set(str, api.F.IdFromString(str));
    return this.ids.get(str);
  }

  /** Отправить пакет (до 1170 байт). Не влезло в очередь EOS — дождётся следующего такта. */
  send(peer, channel, data) {
    this.outbox.push({ peer, channel, data });
    this.flush();
  }

  flush() {
    while (this.outbox.length) {
      const p = this.outbox[0];
      const r = api.F.SendPacket(this.p2p, {
        ApiVersion: 3,
        LocalUserId: this.local,
        RemoteUserId: this.idHandle(p.peer),
        SocketId: this.socket,
        Channel: p.channel,
        DataLengthBytes: p.data.length,
        Data: p.data,
        bAllowDelayedDelivery: 1,
        Reliability: 2, // надёжно и по порядку — поверх этого идёт поток TCP игры
        bDisableAutoAcceptConnection: 0,
      });
      if (r === R.LimitExceeded) return; // очередь EOS полна — допишем на следующем такте
      this.outbox.shift();
      if (r !== R.Success) this.emit('send-error', p.peer, api.F.ResultToString(r));
    }
  }

  accept(peer) {
    return api.F.Accept(this.p2p, { ApiVersion: 1, LocalUserId: this.local, RemoteUserId: this.idHandle(peer), SocketId: this.socket });
  }

  close(peer) {
    this.outbox = this.outbox.filter((p) => p.peer !== peer);
    return api.F.Close(this.p2p, { ApiVersion: 1, LocalUserId: this.local, RemoteUserId: this.idHandle(peer), SocketId: this.socket });
  }

  /** Тип NAT этого ПК: open — прямой путь почти всегда; strict — скорее всего через ретранслятор. */
  natType() {
    const { koffi, T, F } = api;
    return new Promise((resolve) => F.QueryNAT(this.p2p, { ApiVersion: 1 }, null, this.once('nat', (d) => resolve(['unknown', 'open', 'moderate', 'strict'][koffi.decode(d, T.NatInfo).NATType] || 'unknown'))));
  }

  tick() {
    if (!this.platform) return;
    const { F } = api;
    F.PlatformTick(this.platform);
    if (!this.local) return;
    // забираем все пришедшие пакеты
    const size = [0];
    const peer = [null];
    const channel = [0];
    const written = [0];
    const sock = Buffer.alloc(40);
    for (let i = 0; i < 4096; i++) {
      if (F.NextSize(this.p2p, { ApiVersion: 2, LocalUserId: this.local, RequestedChannel: null }, size) !== R.Success) break;
      const data = Buffer.alloc(size[0]);
      if (F.Receive(this.p2p, { ApiVersion: 2, LocalUserId: this.local, MaxDataSizeBytes: data.length, RequestedChannel: null }, peer, sock, channel, data, written) !== R.Success) break;
      this.emit('packet', this.idString(peer[0]), channel[0], data.subarray(0, written[0]));
    }
    this.flush();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.platform) api.F.PlatformRelease(this.platform);
    this.platform = null;
    this.local = null;
    this.puid = null;
  }
}

/** Файлы EOS на этом компьютере: DLL и ключи. null — EOS не настроен (тогда работает сервер комнат или LAN). */
function locate({ resources = null, projectRoot = path.join(__dirname, '..', '..', '..') } = {}) {
  const cands = [];
  if (resources) cands.push({ dll: path.join(resources, 'eos', 'EOSSDK-Win64-Shipping.dll'), keys: path.join(resources, 'eos', 'eos.json') });
  cands.push({ dll: path.join(projectRoot, 'eos-sdk', 'SDK', 'Bin', 'EOSSDK-Win64-Shipping.dll'), keys: path.join(projectRoot, 'eos.local.json') });
  if (process.platform !== 'win32' || process.arch !== 'x64') return null;
  for (const c of cands) {
    try {
      const keys = JSON.parse(fs.readFileSync(c.keys, 'utf8'));
      if (fs.existsSync(c.dll) && ['productId', 'sandboxId', 'deploymentId', 'clientId', 'clientSecret'].every((k) => typeof keys[k] === 'string' && keys[k])) return { dll: c.dll, keys };
    } catch {}
  }
  return null;
}

module.exports = { EosPlatform, locate, load, R };
