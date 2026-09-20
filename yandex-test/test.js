require('dotenv').config();
const { YMApi, WrappedYMApi } = require('yamd2');

const api = new YMApi();
const wrappedApi = new WrappedYMApi();

async function main() {
  const authConfig = {
    access_token: process.env.YM_TOKEN,
    uid: Number(process.env.YM_UID)
  };

  console.log('Авторизуемся по токену...');
  await api.init(authConfig);
  await wrappedApi.init(authConfig);
  console.log('Авторизация успешна!');

  console.log('Проверяем, что реально есть в api и api.search...');
  console.log('Ключи api:', Object.keys(api));
  console.log('api.search:', api.search);

  const query = 'Interstellar Main Theme';
  console.log(`Ищем трек: "${query}"...`);
  const searchResult = await api.search.tracks(query);

  console.log('--- СЫРОЙ ОТВЕТ ---');
  console.log(JSON.stringify(searchResult, null, 2));
}

main().catch((err) => {
  console.error('Ошибка:', err.message);
  console.error(err);
});