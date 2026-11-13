import { Link, Route, Routes } from "react-router-dom";
import { CALLBACK_PATH } from "./auth/AuthProvider";
import { RequireAuth } from "./auth/RequireAuth";
import { useLabAuth } from "./auth/useLabAuth";
import { VULN_MODE } from "./lab/flags";
import { VulnerableSearch } from "./lab/VulnerableSearch";
import { Callback } from "./pages/Callback";
import { Home } from "./pages/Home";
import { Profile } from "./pages/Profile";
import { Protected } from "./pages/Protected";

export function App() {
  const auth = useLabAuth();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <nav className="mx-auto flex max-w-3xl flex-wrap items-center gap-4 px-4 py-3">
          <span className="font-semibold text-teal-700">Edge Defense Lab</span>
          <Link className="text-sm hover:underline" to="/">
            Home
          </Link>
          <Link className="text-sm hover:underline" to="/protected">
            Protected
          </Link>
          <Link className="text-sm hover:underline" to="/profile">
            Profile
          </Link>
          {VULN_MODE && (
            <Link className="text-sm text-red-700 hover:underline" to="/lab/search">
              Vulnerable Search
            </Link>
          )}
          <span className="ml-auto text-sm">
            {auth.isAuthenticated ? (
              <button type="button" onClick={auth.signOut} className="hover:underline">
                ログアウト
              </button>
            ) : (
              auth.configured && (
                <button type="button" onClick={auth.signIn} className="hover:underline">
                  ログイン
                </button>
              )
            )}
          </span>
        </nav>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path={CALLBACK_PATH} element={<Callback />} />
          <Route
            path="/protected"
            element={
              <RequireAuth>
                <Protected />
              </RequireAuth>
            }
          />
          <Route
            path="/profile"
            element={
              <RequireAuth>
                <Profile />
              </RequireAuth>
            }
          />
          {/* 検証専用ページ。VITE_VULN_MODE=true のビルドにだけ含まれる */}
          {VULN_MODE && <Route path="/lab/search" element={<VulnerableSearch />} />}
        </Routes>
      </main>
    </div>
  );
}
