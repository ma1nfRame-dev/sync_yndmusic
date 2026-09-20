// get-link.js
require('dotenv').config();
const { WrappedYMApi } = require('yamd2');

const TRACK_URL = 'https://music.yandex.ru/track/35244922';

async function main() {
  console.log('🔐 Авторизуемся...');
  const wrappedApi = new WrappedYMApi();
  await wrappedApi.init({
    access_token: process.env.YM_TOKEN,
    uid: Number(process.env.YM_UID)
  });
  console.log('✅ Авторизация успешна!');

  console.log(`\n🔍 Получаем download info...`);
  const downloadInfo = await wrappedApi.getDownloadInfo(TRACK_URL, { codec: 'mp3' });

  console.log('\n========================================');
  console.log('🔗 ПРЯМАЯ ССЫЛКА НА АУДИО (downloadInfoUrl):');
  console.log(downloadInfo.downloadInfoUrl);
  console.log('========================================');
}

main().catch((err) => {
  console.error('\n❌ Ошибка:', err.message);
  console.error(err);
});