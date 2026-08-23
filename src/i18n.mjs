// src/i18n.mjs - komunikaty bledow API w wielu jezykach / API error messages in multiple languages.
//
// Kontrakt: stabilny jest `error.code`, nie tresc komunikatu. Klient moze tlumaczyc sam po kodzie,
// ale serwer i tak zwraca tekst w jezyku wynegocjowanym przez Accept-Language albo ?lang=.
//
// Contract: `error.code` is stable, the message text is not. Clients may translate by code,
// but the server still returns text in the language negotiated via Accept-Language or ?lang=.

import config from './config.mjs';

export const LOCALES = ['pl', 'en'];
export const DEFAULT_LOCALE = LOCALES.includes(config.defaultLocale) ? config.defaultLocale : 'pl';

/**
 * Katalog komunikatow. Wartosc moze zawierac placeholdery {name}, uzupelniane z `details`.
 * Klucze MUSZA byc identyczne w obu jezykach - pilnuje tego test jednostkowy.
 */
export const MESSAGES = {
  pl: {
    // --- transport
    invalid_json: 'Body musi byc poprawnym obiektem JSON',
    payload_too_large: 'Payload przekracza limit {limit} bajtow',
    method_not_allowed: 'Metoda niedozwolona dla tej sciezki',
    not_found: 'Nie znaleziono',
    forbidden: 'Brak uprawnien',
    unauthorized: 'Wymagane zalogowanie',
    rate_limited: 'Zbyt wiele zapytan, sprobuj ponownie za chwile',
    internal_error: 'Blad wewnetrzny serwera',
    api_version_removed: 'To API zostalo zastapione. Uzyj {path}',

    // --- konta i sesje
    invalid_credentials: 'Niepoprawny e-mail lub haslo',
    invalid_email: 'Niepoprawny adres e-mail',
    invalid_password: 'Aktualne haslo jest niepoprawne',
    weak_password: 'Haslo nie spelnia wymagan: min. {min} znakow i co najmniej 3 z 4 grup (male litery, wielkie litery, cyfry, znaki specjalne)',
    email_taken: 'Konto z tym adresem juz istnieje',
    account_disabled: 'Konto jest zablokowane',
    account_locked: 'Konto tymczasowo zablokowane po nieudanych probach logowania',
    registration_closed: 'Rejestracja wylacznie na zaproszenie',
    invalid_invite: 'Kod zaproszenia jest niepoprawny lub wygasl',
    invite_not_found: 'Nie znaleziono aktywnego zaproszenia',
    invalid_role: 'Rola musi byc user albo admin',
    user_not_found: 'Uzytkownik nie istnieje',
    csrf_missing: 'Brak naglowka X-CSRF-Token',
    csrf_invalid: 'Niepoprawny token CSRF',
    cross_site_blocked: 'Zadanie cross-site zostalo odrzucone',
    missing_fields: 'Brakuje wymaganych pol: {fields}',

    // --- portfele
    portfolio_not_found: 'Portfel nie istnieje',
    invalid_name: 'Nazwa jest wymagana i moze miec maksymalnie {max} znakow',
    invalid_kind: 'Typ portfela musi byc jeden z: {list}',
    invalid_order: 'Oczekiwano tablicy identyfikatorow',
    too_many_portfolios: 'Osiagnieto limit {max} portfeli na konto',
    confirmation_required: 'Aby usunac portfel, podaj jego dokladna nazwe w polu confirmName',
    portfolio_required: 'Token globalny wymaga wskazania istniejacego portfela w polu portfolioId',

    // --- ledger
    invalid_date: 'Pole {field} musi miec format YYYY-MM-DD',
    invalid_number: 'Pole {field} musi byc poprawna liczba',
    number_must_be_positive: 'Pole {field} musi byc dodatnie',
    number_must_not_be_zero: 'Pole {field} nie moze byc zerem',
    number_out_of_range: 'Pole {field} ma nierealna wartosc',
    invalid_currency: 'Waluta musi byc jedna z: {list}',
    invalid_side: 'Pole side musi byc BUY albo SELL',
    invalid_ticker: 'Pole {field} jest wymagane i moze miec maksymalnie {max} znakow',
    invalid_type: 'Pole type musi byc jedno z: {list}',
    transaction_not_found: 'Transakcja nie istnieje',
    flow_not_found: 'Przeplyw nie istnieje',
    duplicate_transaction: 'Transakcja o tym identyfikatorze zewnetrznym juz istnieje w portfelu',
    duplicate_flow: 'Przeplyw o tym identyfikatorze zewnetrznym juz istnieje w portfelu',
    empty_import: 'Import wymaga tablicy transactions lub cashFlows',

    // --- import z pliku
    import_empty_file: 'Plik jest pusty',
    import_no_rows: 'Plik nie zawiera zadnych wierszy z danymi - potrzebny naglowek i co najmniej jeden wiersz',
    import_too_many_rows: 'Plik ma {got} wierszy, limit to {max}. Podziel go na czesci',
    import_shape_unknown: 'Nie rozpoznano ukladu pliku. Brakuje kolumn: {missing}. Przypisz je recznie albo pobierz wzorzec',
    import_nothing_to_insert: 'Nie ma czego zapisac - wszystkie wiersze sa duplikatami albo maja bledy',
    import_row_invalid: 'Wiersz zawiera dane, ktorych nie da sie odczytac',
    import_batch_not_found: 'Ten import nie istnieje',
    import_batch_already_undone: 'Ten import zostal juz cofniety',
    import_batch_not_reversible: 'Importu stanu portfela nie da sie cofnac - nadpisal poprzednie wartosci',

    // --- dane rynkowe i webhooki
    missing_symbol: 'Parametr symbol jest wymagany',
    unsupported_source: 'Nieobslugiwane zrodlo: {source}. Dostepne: {list}',
    unparsed_message: 'Nie udalo sie sparsowac tresci zlecenia',
    invalid_token: 'Niepoprawny token',
    share_expired: 'Link wygasl lub zostal uniewazniony',
    admin_required: 'Wymagane uprawnienia administratora',
    endpoint_not_found: 'Nieznany endpoint API',
    resource_not_found: 'Nie znaleziono zasobu',
    password_too_long: 'Haslo jest zbyt dlugie (maksymalnie {max} znakow)',
    password_too_common: 'Haslo jest zbyt oczywiste',
    email_too_long: 'Adres e-mail jest zbyt dlugi',
    webhook_token_missing: 'Brak naglowka Authorization: Bearer <token>',
    webhook_token_invalid: 'Niepoprawny token webhooka',
    owner_protected: 'Nie mozna zablokowac ani zdegradowac wlasciciela instancji',
    self_lock_forbidden: 'Nie mozna zablokowac wlasnego konta',
    share_not_found: 'Link nie istnieje',
  },

  en: {
    // --- transport
    invalid_json: 'Request body must be a valid JSON object',
    payload_too_large: 'Payload exceeds the {limit} byte limit',
    method_not_allowed: 'Method not allowed for this path',
    not_found: 'Not found',
    forbidden: 'Not permitted',
    unauthorized: 'Sign-in required',
    rate_limited: 'Too many requests, please try again shortly',
    internal_error: 'Internal server error',
    api_version_removed: 'This API has been replaced. Use {path}',

    // --- accounts and sessions
    invalid_credentials: 'Incorrect email or password',
    invalid_email: 'Invalid email address',
    invalid_password: 'Current password is incorrect',
    weak_password: 'Password does not meet the requirements: at least {min} characters and 3 of 4 groups (lowercase, uppercase, digits, symbols)',
    email_taken: 'An account with this email already exists',
    account_disabled: 'This account is disabled',
    account_locked: 'Account temporarily locked after failed sign-in attempts',
    registration_closed: 'Registration is by invitation only',
    invalid_invite: 'The invitation code is invalid or has expired',
    invite_not_found: 'No active invitation found',
    invalid_role: 'Role must be either user or admin',
    user_not_found: 'User does not exist',
    csrf_missing: 'Missing X-CSRF-Token header',
    csrf_invalid: 'Invalid CSRF token',
    cross_site_blocked: 'Cross-site request rejected',
    missing_fields: 'Missing required fields: {fields}',

    // --- portfolios
    portfolio_not_found: 'Portfolio does not exist',
    invalid_name: 'Name is required and may be at most {max} characters',
    invalid_kind: 'Portfolio type must be one of: {list}',
    invalid_order: 'Expected an array of identifiers',
    too_many_portfolios: 'Reached the limit of {max} portfolios per account',
    confirmation_required: 'To delete a portfolio, provide its exact name in the confirmName field',
    portfolio_required: 'The global token requires an existing portfolio in the portfolioId field',

    // --- ledger
    invalid_date: 'Field {field} must use the YYYY-MM-DD format',
    invalid_number: 'Field {field} must be a valid number',
    number_must_be_positive: 'Field {field} must be positive',
    number_must_not_be_zero: 'Field {field} must not be zero',
    number_out_of_range: 'Field {field} has an implausible value',
    invalid_currency: 'Currency must be one of: {list}',
    invalid_side: 'Field side must be BUY or SELL',
    invalid_ticker: 'Field {field} is required and may be at most {max} characters',
    invalid_type: 'Field type must be one of: {list}',
    transaction_not_found: 'Transaction does not exist',
    flow_not_found: 'Cash flow does not exist',
    duplicate_transaction: 'A transaction with this external id already exists in the portfolio',
    duplicate_flow: 'A cash flow with this external id already exists in the portfolio',
    empty_import: 'Import requires a transactions or cashFlows array',

    // --- file import
    import_empty_file: 'The file is empty',
    import_no_rows: 'The file contains no data rows - a header and at least one row are required',
    import_too_many_rows: 'The file has {got} rows, the limit is {max}. Please split it',
    import_shape_unknown: 'Could not recognise the file layout. Missing columns: {missing}. Map them manually or download a template',
    import_nothing_to_insert: 'Nothing to save - every row is either a duplicate or invalid',
    import_row_invalid: 'This row contains data that cannot be read',
    import_batch_not_found: 'This import does not exist',
    import_batch_already_undone: 'This import has already been undone',
    import_batch_not_reversible: 'A holdings import cannot be undone - it overwrote the previous values',

    // --- market data and webhooks
    missing_symbol: 'The symbol parameter is required',
    unsupported_source: 'Unsupported source: {source}. Available: {list}',
    unparsed_message: 'Could not parse the order text',
    invalid_token: 'Invalid token',
    share_expired: 'This link has expired or has been revoked',
    admin_required: 'Administrator privileges required',
    endpoint_not_found: 'Unknown API endpoint',
    resource_not_found: 'Resource not found',
    password_too_long: 'Password is too long (maximum {max} characters)',
    password_too_common: 'Password is too obvious',
    email_too_long: 'Email address is too long',
    webhook_token_missing: 'Missing Authorization: Bearer <token> header',
    webhook_token_invalid: 'Invalid webhook token',
    owner_protected: 'The instance owner cannot be disabled or demoted',
    self_lock_forbidden: 'You cannot disable your own account',
    share_not_found: 'Link does not exist',
  },
};

/** Naglowki CSV per jezyk - eksport ma byc czytelny w arkuszu uzytkownika. */
export const CSV_HEADERS = {
  pl: {
    portfolio: 'portfel', ticker: 'ticker', currency: 'waluta', qty: 'ilosc',
    avgPrice: 'srednia_cena_zakupu', lastPrice: 'ostatnia_cena',
    valuePln: 'wartosc_pln', pnlPln: 'wynik_pln', weightPct: 'udzial_pct',
  },
  en: {
    portfolio: 'portfolio', ticker: 'ticker', currency: 'currency', qty: 'quantity',
    avgPrice: 'avg_buy_price', lastPrice: 'last_price',
    valuePln: 'value_pln', pnlPln: 'pnl_pln', weightPct: 'weight_pct',
  },
};

/** Nazwy domyslnych obiektow tworzonych przez system. */
export const DEFAULTS = {
  pl: { defaultPortfolioName: 'Portfel glowny' },
  en: { defaultPortfolioName: 'Main portfolio' },
};

export function isSupported(locale) {
  return LOCALES.includes(String(locale ?? '').toLowerCase());
}

/**
 * Negocjacja jezyka: jawny parametr ma pierwszenstwo, potem Accept-Language, na koncu domyslny.
 * Parser obsluguje wagi q, np. "en-GB,en;q=0.9,pl;q=0.8".
 */
export function negotiateLocale(acceptLanguage, override = null) {
  if (isSupported(override)) return String(override).toLowerCase();

  const candidates = String(acceptLanguage ?? '')
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { tag: tag.trim().toLowerCase(), q: q ? Number.parseFloat(q.split('=')[1]) : 1 };
    })
    .filter((item) => item.tag && Number.isFinite(item.q))
    .sort((a, b) => b.q - a.q);

  for (const { tag } of candidates) {
    const base = tag.split('-')[0];
    if (isSupported(base)) return base;
  }
  return DEFAULT_LOCALE;
}

/** Podstawia {placeholdery} wartosciami z obiektu details. */
export function interpolate(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (
    params[key] === undefined || params[key] === null ? match : String(params[key])
  ));
}

/**
 * Komunikat dla kodu bledu. Zwraca null, gdy kod nie ma wpisu w katalogu -
 * wtedy warstwa HTTP uzywa oryginalnej tresci wyjatku.
 */
export function errorMessage(code, locale = DEFAULT_LOCALE, params = {}) {
  const catalog = MESSAGES[isSupported(locale) ? locale : DEFAULT_LOCALE];
  const template = catalog?.[code];
  return template ? interpolate(template, params) : null;
}

export function csvHeaders(locale = DEFAULT_LOCALE) {
  return CSV_HEADERS[isSupported(locale) ? locale : DEFAULT_LOCALE];
}

export function defaults(locale = DEFAULT_LOCALE) {
  return DEFAULTS[isSupported(locale) ? locale : DEFAULT_LOCALE];
}
