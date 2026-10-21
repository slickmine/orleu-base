// Настройки подключения. Ключ anon — публичный, его можно хранить в открытом репозитории:
// доступ к данным защищён входом по паролю и правилами базы (RLS).
window.ORLEU_CONFIG = {
  SUPABASE_URL: 'https://ypwaepxddsrumtmxebhk.supabase.co',       // https://xxxxxxxx.supabase.co
  SUPABASE_ANON_KEY: 'sb_publishable_HKKtStKMJO8pDbndtb4suA_54-wi5o8',  // Project Settings → API → anon public
  // Адрес сайта для QR-кодов. Пусто — берётся адрес, по которому открыт сайт
  // (после передачи репозитория другому владельцу QR автоматически ведут на новый адрес).
  SITE_URL: '',
};
