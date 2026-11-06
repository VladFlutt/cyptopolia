import { useState } from 'react';
import { navigate } from '../App';
import { Header } from '../components/ui';

export function Home() {
  const [code, setCode] = useState('');
  const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (
    <>
      <Header />
      <main className="page narrow">
        <h1>Криптополия</h1>
        <p className="lead">
          Экономическая игра на бумажном поле, где все расчёты идут в настоящей блокчейн-сети. Платите из своего
          криптокошелька и учитесь пользоваться реальными инструментами.
        </p>
        <div className="cards">
          <section className="card">
            <h2>Я игрок</h2>
            <p>Отсканируйте QR-код с экрана ведущего или введите код партии.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (clean.length >= 4) navigate(`/j/${clean}`);
              }}
              className="row"
            >
              <input
                aria-label="Код партии"
                placeholder="Код, например K7M2QX"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={12}
                autoCapitalize="characters"
              />
              <button type="submit" disabled={clean.length < 4}>
                Войти
              </button>
            </form>
          </section>
          <section className="card">
            <h2>Я ведущий</h2>
            <p>Создайте партию, покажите QR-код игрокам и управляйте банком.</p>
            <button type="button" onClick={() => navigate('/admin')}>
              Открыть админку
            </button>
          </section>
        </div>
      </main>
    </>
  );
}
