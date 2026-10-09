import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
} from "react";
import { Navigate, useLocation } from "react-router-dom";
import { request, bumpAuthEpoch } from "../services/api";
import { Loading, Card, Notice, Button } from "./ui";
const Context = createContext(null);
export const useAuth = () => useContext(Context);
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null),
    [loading, setLoading] = useState(true),
    [expired, setExpired] = useState(false),
    [authError, setAuthError] = useState("");
  const generation = useRef(0);
  const loggingOut = useRef(false);
  const refresh = async () => {
    const current = ++generation.current;
    setLoading(true);
    setAuthError("");
    try {
      const d = await request("/auth/me");
      if (current === generation.current) setUser(d.user);
    } catch (error) {
      if (current !== generation.current) return;
      if (error.status === 401) setUser(null);
      else setAuthError(error.message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    refresh();
    const handler = () => {
      if (loggingOut.current) return;
      bumpAuthEpoch();
      generation.current++;
      setUser(null);
      setExpired(true);
      setAuthError("");
      setLoading(false);
    };
    window.addEventListener("session-expired", handler);
    return () => {
      generation.current++;
      window.removeEventListener("session-expired", handler);
    };
  }, []);
  const login = async (body, admin = false) => {
    bumpAuthEpoch();
    const current = ++generation.current;
    try {
      const d = await request(admin ? "/auth/admin/login" : "/auth/login", {
        method: "POST",
        body,
      });
      if (current === generation.current) {
        setUser(d.user);
        setExpired(false);
        setAuthError("");
        setLoading(false);
      }
      return d.user;
    } finally {
      if (current === generation.current) setLoading(false);
    }
  };
  const logout = async () => {
    loggingOut.current = true;
    bumpAuthEpoch();
    const current = ++generation.current;
    try {
      await request("/auth/logout", { method: "POST" });
      if (current !== generation.current) return;
      setUser(null);
      setExpired(false);
      setAuthError("");
      setLoading(false);
    } catch (error) {
      if (current === generation.current) setAuthError(error.message);
      throw error;
    } finally {
      loggingOut.current = false;
    }
  };
  return (
    <Context.Provider
      value={{ user, loading, login, logout, refresh, expired, authError }}
    >
      {children}
    </Context.Provider>
  );
}
export function Guard({ children, admin = false }) {
  const { user, loading, authError, refresh } = useAuth(),
    location = useLocation();
  if (loading) return <Loading />;
  if (authError)
    return (
      <Card>
        <Notice error>{authError}</Notice>
        <Button onClick={refresh}>Retry session check</Button>
      </Card>
    );
  if (!user)
    return (
      <Navigate
        to={admin ? "/admin/login" : "/login"}
        state={{ from: location.pathname }}
        replace
      />
    );
  if (admin && user.role !== "ADMIN")
    return <Navigate to="/dashboard" replace />;
  return children;
}
