import React from "react";
import ReactDOM from "react-dom/client";
import { Refine } from "@refinedev/core";
import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { AdminApp } from "./App";
import { authProvider, dataProvider } from "./providers";
import "./style.css";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      button={{ autoInsertSpace: false }}
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#355ae8",
          borderRadius: 8,
          fontFamily:
            'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
      }}
    >
      <AntApp>
        <Refine
          authProvider={authProvider}
          dataProvider={dataProvider}
          resources={[
            "users",
            "activation-codes",
            "admins",
            "audit",
            "projects",
            "jobs",
          ].map((name) => ({ name }))}
          options={{ disableTelemetry: true }}
        >
          <AdminApp />
        </Refine>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
