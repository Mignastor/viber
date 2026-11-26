import type { ArchModel, ArchNode, ArchEdge } from '@shared/model'

// A made-up sample project ("Verdant", a plant-care app) used by the simulated session.
// In Phase 2 this comes from the extractor instead.

const nodes: ArchNode[] = [
  // ── Actors & externals ────────────────────────────────────────────
  {
    id: 'gardener',
    label: 'Gardener',
    kind: 'actor',
    actorType: 'user',
    purpose: 'A person tracking their plants through the web app.',
    files: [],
    symbols: []
  },
  {
    id: 'cron',
    label: 'Nightly job',
    kind: 'actor',
    actorType: 'cron',
    tech: '0 6 * * *',
    purpose: 'Scheduled trigger that computes and sends care reminders every morning.',
    files: ['deploy/cron.yaml'],
    symbols: []
  },
  {
    id: 'openweather',
    label: 'OpenWeather API',
    kind: 'external',
    tech: 'HTTPS',
    purpose: 'Third-party forecast API used to adapt watering schedules to rain and heat.',
    files: [],
    symbols: []
  },
  {
    id: 'push',
    label: 'Push (FCM)',
    kind: 'external',
    tech: 'HTTPS',
    purpose: 'Firebase Cloud Messaging, delivers reminder notifications to devices.',
    files: [],
    symbols: []
  },

  // ── Web app ───────────────────────────────────────────────────────
  {
    id: 'web',
    label: 'Web App',
    kind: 'box',
    tech: 'React · Vite',
    purpose: 'Single-page app where gardeners log in, see their garden and record care actions.',
    files: [],
    symbols: []
  },
  {
    id: 'gardenView',
    parent: 'web',
    label: 'Garden View',
    kind: 'box',
    tech: 'React',
    purpose: 'Main screen: grid of plants with their next care action and status.',
    files: ['web/src/pages/GardenView.tsx'],
    symbols: [
      { name: 'GardenView', signature: 'function GardenView(): JSX.Element', file: 'web/src/pages/GardenView.tsx' }
    ],
    tests: ['web/src/pages/GardenView.test.tsx']
  },
  {
    id: 'authUi',
    parent: 'web',
    label: 'Login Screen',
    kind: 'box',
    tech: 'React',
    purpose: 'Email + password login form; stores the session token.',
    files: ['web/src/pages/Login.tsx'],
    symbols: [{ name: 'Login', signature: 'function Login(): JSX.Element', file: 'web/src/pages/Login.tsx' }]
  },
  {
    id: 'apiClient',
    parent: 'web',
    label: 'API Client',
    kind: 'box',
    tech: 'fetch',
    purpose: 'Typed wrapper around the backend HTTP API; attaches the auth header.',
    files: ['web/src/api/client.ts'],
    symbols: [
      { name: 'api.login', signature: 'login(email: string, password: string): Promise<void>', file: 'web/src/api/client.ts' },
      { name: 'api.plants', signature: 'plants(): Promise<Plant[]>', file: 'web/src/api/client.ts' },
      { name: 'request', signature: 'request<T>(path: string, init?: RequestInit): Promise<T>', file: 'web/src/api/client.ts' }
    ],
    tests: ['web/src/api/client.test.ts']
  },

  // ── Backend ───────────────────────────────────────────────────────
  {
    id: 'backend',
    label: 'Backend',
    kind: 'box',
    tech: 'Node · Fastify',
    purpose: 'HTTP API, domain logic and background jobs.',
    files: ['src/main.ts'],
    symbols: []
  },
  {
    id: 'http',
    parent: 'backend',
    label: 'HTTP API',
    kind: 'box',
    tech: 'Fastify',
    purpose: 'Route table and request validation. Delegates to domain modules.',
    files: ['src/http/server.ts', 'src/http/routes/auth.ts'],
    symbols: [
      { name: 'buildServer', signature: 'buildServer(deps: Deps): FastifyInstance', file: 'src/http/server.ts' },
      { name: 'authRoutes', signature: 'authRoutes(app: FastifyInstance, deps: Deps): void', file: 'src/http/routes/auth.ts' }
    ],
    tests: ['src/http/routes/auth.test.ts']
  },
  {
    id: 'auth',
    parent: 'backend',
    label: 'Auth',
    kind: 'box',
    tech: 'JWT',
    purpose: 'Verifies credentials, issues access tokens and tracks sessions.',
    files: [],
    symbols: []
  },
  {
    id: 'loginHandler',
    parent: 'auth',
    label: 'LoginHandler',
    kind: 'box',
    purpose: 'Checks email/password against the users table and starts a session.',
    files: ['src/auth/login.ts'],
    symbols: [
      { name: 'login', signature: 'login(email: string, password: string): Promise<string>', file: 'src/auth/login.ts' }
    ],
    tests: ['src/auth/login.test.ts']
  },
  {
    id: 'tokenService',
    parent: 'auth',
    label: 'TokenService',
    kind: 'box',
    purpose: 'Signs and verifies JWT access tokens.',
    files: ['src/auth/tokens.ts'],
    symbols: [
      { name: 'issue', signature: 'issue(userId: string): string', file: 'src/auth/tokens.ts' },
      { name: 'verify', signature: 'verify(token: string): Claims | null', file: 'src/auth/tokens.ts' }
    ],
    tests: ['src/auth/tokens.test.ts']
  },
  {
    id: 'sessionStore',
    parent: 'auth',
    label: 'SessionStore',
    kind: 'box',
    purpose: 'Persists active sessions for audit and logout-everywhere.',
    files: ['src/auth/sessions.ts'],
    symbols: [
      { name: 'createSession', signature: 'createSession(userId: string): Promise<Session>', file: 'src/auth/sessions.ts' },
      { name: 'revokeAll', signature: 'revokeAll(userId: string): Promise<void>', file: 'src/auth/sessions.ts' }
    ]
  },
  {
    id: 'plants',
    parent: 'backend',
    label: 'Plants',
    kind: 'box',
    purpose: 'Plant catalogue per garden, and the rules that decide when each plant needs care.',
    files: [],
    symbols: []
  },
  {
    id: 'plantRoutes',
    parent: 'plants',
    label: 'PlantRoutes',
    kind: 'box',
    purpose: 'CRUD endpoints for plants and care logs.',
    files: ['src/plants/routes.ts'],
    symbols: [{ name: 'plantRoutes', signature: 'plantRoutes(app: FastifyInstance, deps: Deps): void', file: 'src/plants/routes.ts' }],
    tests: ['src/plants/routes.test.ts']
  },
  {
    id: 'plantRepo',
    parent: 'plants',
    label: 'PlantRepo',
    kind: 'box',
    purpose: 'SQL access for plants and care logs.',
    files: ['src/plants/repo.ts'],
    symbols: [
      { name: 'listPlants', signature: 'listPlants(userId: string): Promise<Plant[]>', file: 'src/plants/repo.ts' },
      { name: 'logCare', signature: 'logCare(plantId: string, action: CareAction): Promise<void>', file: 'src/plants/repo.ts' }
    ]
  },
  {
    id: 'careRules',
    parent: 'plants',
    label: 'CareRules',
    kind: 'box',
    purpose: 'Computes the next watering/feeding date from species, last care and forecast.',
    files: ['src/plants/careRules.ts'],
    symbols: [
      { name: 'nextCare', signature: 'nextCare(plant: Plant, forecast: Forecast): CareDue', file: 'src/plants/careRules.ts' }
    ],
    tests: ['src/plants/careRules.test.ts']
  },
  {
    id: 'reminders',
    parent: 'backend',
    label: 'Reminders',
    kind: 'box',
    purpose: 'Daily job that finds plants due for care and notifies their owners.',
    files: [],
    symbols: []
  },
  {
    id: 'scheduler',
    parent: 'reminders',
    label: 'Scheduler',
    kind: 'box',
    purpose: 'Entry point of the nightly job.',
    files: ['src/reminders/scheduler.ts'],
    symbols: [{ name: 'runDaily', signature: 'runDaily(now: Date): Promise<RunReport>', file: 'src/reminders/scheduler.ts' }],
    tests: ['src/reminders/scheduler.test.ts']
  },
  {
    id: 'reminderRepo',
    parent: 'reminders',
    label: 'ReminderRepo',
    kind: 'box',
    purpose: 'Records which reminders were sent to avoid duplicates.',
    files: ['src/reminders/repo.ts'],
    symbols: [{ name: 'markSent', signature: 'markSent(plantId: string, day: string): Promise<boolean>', file: 'src/reminders/repo.ts' }]
  },
  {
    id: 'weather',
    parent: 'backend',
    label: 'Weather Adapter',
    kind: 'box',
    purpose: 'Fetches and caches 3-day forecasts per garden location.',
    files: ['src/weather/openweather.ts'],
    symbols: [{ name: 'getForecast', signature: 'getForecast(lat: number, lon: number): Promise<Forecast>', file: 'src/weather/openweather.ts' }]
  },
  {
    id: 'notifier',
    parent: 'backend',
    label: 'Notifier',
    kind: 'box',
    purpose: 'Formats and sends push notifications.',
    files: ['src/notify/push.ts'],
    symbols: [{ name: 'notify', signature: 'notify(userId: string, msg: Notification): Promise<void>', file: 'src/notify/push.ts' }]
  },

  // ── Data ──────────────────────────────────────────────────────────
  {
    id: 'db',
    label: 'Postgres',
    kind: 'datastore',
    tech: 'PostgreSQL 16',
    purpose: 'Primary database: users, sessions, plants, care logs, reminders.',
    files: ['db/migrations/0001_init.sql', 'db/migrations/0006_reminders.sql'],
    symbols: [
      { name: 'users', signature: 'TABLE users(id, email, password_hash, created_at)', file: 'db/migrations/0001_init.sql' },
      { name: 'sessions', signature: 'TABLE sessions(id, user_id, created_at, revoked_at)', file: 'db/migrations/0001_init.sql' },
      { name: 'plants', signature: 'TABLE plants(id, user_id, species, last_watered_at)', file: 'db/migrations/0001_init.sql' }
    ]
  }
]

const e = (id: string, source: string, target: string, kind: ArchEdge['kind'], label: string, contract: string[]): ArchEdge => ({
  id,
  source,
  target,
  kind,
  label,
  contract
})

const edges: ArchEdge[] = [
  e('e_gardener_garden', 'gardener', 'gardenView', 'uses', 'views garden', ['Browser · /garden']),
  e('e_gardener_login', 'gardener', 'authUi', 'uses', 'logs in', ['Browser · /login']),
  e('e_garden_api', 'gardenView', 'apiClient', 'call', 'api.plants()', ['plants(): Promise<Plant[]>']),
  e('e_login_api', 'authUi', 'apiClient', 'call', 'api.login()', ['login(email, password): Promise<void>']),
  e('e_api_http', 'apiClient', 'http', 'http', 'REST', [
    'POST /auth/login {email, password} → {token}',
    'GET /plants → Plant[]',
    'POST /plants/:id/care {action} → 204'
  ]),
  e('e_http_login', 'http', 'loginHandler', 'call', 'login()', ['login(email: string, password: string): Promise<string>']),
  e('e_http_plants', 'http', 'plantRoutes', 'call', 'plantRoutes', ['plantRoutes(app, deps): void']),
  e('e_login_token', 'loginHandler', 'tokenService', 'call', 'issue()', ['issue(userId: string): string']),
  e('e_login_session', 'loginHandler', 'sessionStore', 'call', 'createSession()', ['createSession(userId: string): Promise<Session>']),
  e('e_session_db', 'sessionStore', 'db', 'sql', 'sessions', ['INSERT/UPDATE sessions']),
  e('e_login_db', 'loginHandler', 'db', 'sql', 'users', ['SELECT users WHERE email = $1']),
  e('e_routes_repo', 'plantRoutes', 'plantRepo', 'call', 'listPlants()', ['listPlants(userId): Promise<Plant[]>', 'logCare(plantId, action): Promise<void>']),
  e('e_routes_rules', 'plantRoutes', 'careRules', 'call', 'nextCare()', ['nextCare(plant, forecast): CareDue']),
  e('e_repo_db', 'plantRepo', 'db', 'sql', 'plants', ['SELECT/INSERT plants, care_logs']),
  e('e_rules_weather', 'careRules', 'weather', 'call', 'getForecast()', ['getForecast(lat, lon): Promise<Forecast>']),
  e('e_weather_ow', 'weather', 'openweather', 'external', 'forecast', ['GET api.openweathermap.org/data/3.0/onecall']),
  e('e_cron_sched', 'cron', 'scheduler', 'event', 'triggers', ['runDaily(now: Date)']),
  e('e_sched_rules', 'scheduler', 'careRules', 'call', 'nextCare()', ['nextCare(plant, forecast): CareDue']),
  e('e_sched_repo', 'scheduler', 'reminderRepo', 'call', 'markSent()', ['markSent(plantId, day): Promise<boolean>']),
  e('e_reminder_db', 'reminderRepo', 'db', 'sql', 'reminders', ['INSERT reminders ON CONFLICT DO NOTHING']),
  e('e_sched_notify', 'scheduler', 'notifier', 'call', 'notify()', ['notify(userId, msg): Promise<void>']),
  e('e_notify_push', 'notifier', 'push', 'external', 'send', ['POST fcm.googleapis.com/v1/projects/*/messages:send'])
]

export const sampleModel: ArchModel = { name: 'verdant', nodes, edges }
