import { useEffect, useRef, useState } from "react";
import { useList } from "@refinedev/core";
import {
  Alert,
  App,
  Avatar,
  Button,
  Card,
  DatePicker,
  Empty,
  Form,
  Input,
  InputNumber,
  Layout,
  Menu,
  Modal,
  Popconfirm,
  Result,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
} from "antd";
import {
  AuditOutlined,
  KeyOutlined,
  LogoutOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
  UserOutlined,
  VideoCameraOutlined,
  ProjectOutlined,
  CloudOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import {
  authProvider,
  getAdmin,
  mutation,
  batchChannelAccounts,
  refreshChannelCredits,
  cleanupChannelAccounts,
  type ChannelBatchAction,
  type AdminIdentity,
  type Role,
} from "./providers";
const { Title, Text, Paragraph } = Typography;
type Row = Record<string, any> & { id: string };
type CredentialFile = {
  key: number;
  name: string;
  credentials?: string;
  status: "ready" | "invalid" | "importing" | "succeeded" | "failed";
  error?: string;
};
const roleNames: Record<Role, string> = {
  superadmin: "超级管理员",
  operator: "运营管理员",
  readonly: "只读管理员",
};
const names: Record<string, string> = {
  users: "账户管理",
  "sharing-whitelist": "共享资格白名单",
  "activation-codes": "激活码",
  admins: "管理员",
  projects: "项目成员权限",
  "system-jobs": "渠道任务",
  channels: "渠道账户",
  audit: "审计日志",
};
const icons = [
  <UserOutlined />,
  <TeamOutlined />,
  <KeyOutlined />,
  <SafetyCertificateOutlined />,
  <ProjectOutlined />,
  <VideoCameraOutlined />,
  <CloudOutlined />,
  <AuditOutlined />,
];
const date = (value: unknown) =>
  value ? new Date(String(value)).toLocaleString("zh-CN") : "—";
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，请稍后重试。";
const tag = (value: unknown) => (
  <Tag
    color={
      ["active", "available", "succeeded", "completed"].includes(String(value))
        ? "green"
        : ["revoked", "disabled", "failed"].includes(String(value))
          ? "red"
          : "default"
    }
  >
    {String(value ?? "—")}
  </Tag>
);
const channelBatchNames: Record<ChannelBatchAction, string> = {
  enable: "启用",
  disable: "停用",
  archive: "归档",
  restore: "恢复",
};
const channelCleanupReasons: Record<string, string> = {
  "insufficient-credits": "不足最低生成额度",
  "credentials-expired": "凭据失效，无法续期",
  manual: "管理员手动归档",
};
function ChannelCredits({ account }: { account: Row }) {
  const known = typeof account.credits === "number" && Number.isFinite(account.credits);
  return (
    <div className="channel-credits">
      {account.creditStatus === "error" ? (
        <>
          <Text type="danger">读取失败</Text>
          {known && <Text type="secondary">上次成功：{account.credits.toLocaleString("zh-CN")} 积分</Text>}
        </>
      ) : known ? (
        <Text strong>{account.credits.toLocaleString("zh-CN")}</Text>
      ) : (
        <Text type="secondary">未查询</Text>
      )}
    </div>
  );
}
export function AdminApp() {
  const [identity, setIdentity] = useState<AdminIdentity | null>(null),
    [checking, setChecking] = useState(true),
    [authError, setAuthError] = useState(""),
    [section, setSection] = useState("users"),
    [busy, setBusy] = useState(false);
  const { message } = App.useApp();
  const check = async () => {
    setChecking(true);
    try {
      setIdentity(await getAdmin());
      setAuthError("");
    } catch (error) {
      setIdentity(null);
      setAuthError(errorText(error));
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    void check();
  }, []);
  if (checking)
    return (
      <div className="full-state">
        <Spin size="large" />
      </div>
    );
  if (!identity)
    return (
      <div className="login-shell">
        <div className="login-copy">
          <div className="brand">
            A<span>I</span> STUDIO
          </div>
          <Title>让创作保持有序。</Title>
          <Paragraph>
            账户、访问权限与渠道任务，
            <br />
            在同一处管理。
          </Paragraph>
          <div className="login-mark">
            <SafetyCertificateOutlined /> 管理会话 · 服务端授权
          </div>
        </div>
        <Card className="login-card">
          <Text type="secondary">MANAGEMENT CONSOLE</Text>
          <Title level={2}>登录管理后台</Title>
          <Paragraph type="secondary">使用已获授权的管理员账户。</Paragraph>
          {authError && (
            <Alert
              type="error"
              showIcon
              title={authError}
              style={{ marginBottom: 20 }}
            />
          )}
          <Form
            layout="vertical"
            onFinish={async (values) => {
              setBusy(true);
              setAuthError("");
              try {
                const result = await authProvider.login(values);
                if (result.success) await check();
                else setAuthError(result.error?.message || "登录失败");
              } catch (error) {
                setAuthError(errorText(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Form.Item
              name="email"
              label="邮箱"
              rules={[
                { required: true, message: "请输入邮箱" },
                { type: "email", message: "请输入有效邮箱" },
              ]}
            >
              <Input
                autoComplete="username"
                size="large"
                placeholder="admin@example.com"
              />
            </Form.Item>
            <Form.Item
              name="password"
              label="密码"
              rules={[{ required: true, message: "请输入密码" }]}
            >
              <Input.Password autoComplete="current-password" size="large" />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              block
              size="large"
              loading={busy}
            >
              登录
            </Button>
          </Form>
          <Paragraph className="login-note" type="secondary">
            管理员由超级管理员授予，后台不开放管理员注册。
          </Paragraph>
        </Card>
      </div>
    );
  return (
    <Layout className="console">
      <Layout.Sider
        width={232}
        theme="light"
        breakpoint="lg"
        collapsedWidth={64}
      >
        <div className="sidebar-brand">
          <div className="brand">
            A<span>I</span> STUDIO
          </div>
          <Text type="secondary">管理控制台</Text>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[section]}
          items={Object.entries(names)
            .map(([key, label], i) => ({ key, label, icon: icons[i] }))
            .filter(
              (item) => item.key !== "admins" || identity.role === "superadmin",
            )}
          onClick={({ key }) => setSection(key)}
        />
        <div className="sidebar-footer">
          <span className="live-dot" />
          权限由服务端校验
        </div>
      </Layout.Sider>
      <Layout>
        <Layout.Header className="topbar">
          <Space>
            <Tag color="blue">管理后台</Tag>
            <Text type="secondary">SYSTEM OPERATIONS</Text>
          </Space>
          <Space>
            <Avatar size="small" icon={<UserOutlined />} />
            <Text>{identity.name || identity.email}</Text>
            <Tag>{roleNames[identity.role]}</Tag>
            <Button
              icon={<LogoutOutlined />}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await authProvider.logout({});
                  if (!result.success) throw result.error;
                  setIdentity(null);
                  setAuthError("");
                } catch (error) {
                  message.error(errorText(error));
                } finally {
                  setBusy(false);
                }
              }}
            >
              退出
            </Button>
          </Space>
        </Layout.Header>
        <Layout.Content className="workspace">
          <div className="page-heading">
            <div>
              <Text className="eyebrow">
                WORKSPACE / {section.toUpperCase()}
              </Text>
              <Title level={2}>{names[section]}</Title>
              <Paragraph type="secondary">
                {section === "system-jobs"
                  ? "脱敏运行状态，不含创作正文、结果或渠道凭据。"
                  : section === "projects"
                    ? "项目权限与管理员角色分开授权。此处不展示项目正文。"
                    : "查看当前状态，执行授权范围内的管理操作。"}
              </Paragraph>
            </div>
            <Tag icon={<SafetyCertificateOutlined />}>
              {identity.role === "readonly" ? "只读访问" : "操作将写入审计"}
            </Tag>
          </div>
          {identity.role === "readonly" && (
            <Alert
              type="info"
              showIcon
              title="当前账户为只读管理员，不能修改数据。"
              className="readonly-banner"
            />
          )}
          <ResourcePage
            key={section}
            section={section}
            identity={identity}
            onExpired={() => {
              setIdentity(null);
              setAuthError("管理会话已失效，请重新登录。");
            }}
          />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
function ResourcePage({
  section,
  identity,
  onExpired,
}: {
  section: string;
  identity: AdminIdentity;
  onExpired: () => void;
}) {
  const resource = section === "channels" ? "channels/accounts" : section;
  const [page, setPage] = useState(1),
    [size, setSize] = useState(20),
    [q, setQ] = useState("");
  const { query, result } = useList<Row>({
    resource,
    pagination: { currentPage: page, pageSize: size },
    filters: [{ field: "q", operator: "contains", value: q }],
    queryOptions: { retry: false },
  });
  const [pending, setPending] = useState(""),
    [operationError, setOperationError] = useState(""),
    [dialog, setDialog] = useState(""),
    [codes, setCodes] = useState<Row[]>([]),
    [project, setProject] = useState<Row | null>(null),
    [channelJobs, setChannelJobs] = useState<Row | null>(null);
  const [form] = Form.useForm();
  const credentialFileInput = useRef<HTMLInputElement>(null);
  const fileReadVersion = useRef(0);
  const credentialSubmitting = useRef(false);
  const [fileReading, setFileReading] = useState(false);
  const [fileError, setFileError] = useState("");
  const [fileInfo, setFileInfo] = useState("");
  const [credentialFiles, setCredentialFiles] = useState<CredentialFile[]>([]);
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>([]);
  const [channelResult, setChannelResult] = useState<{ text: string; warning: boolean } | null>(null);
  const readyFileCount = credentialFiles.filter(
    (file) => file.status === "ready",
  ).length;
  const clearFileSelection = () => {
    fileReadVersion.current++;
    if (credentialFileInput.current) credentialFileInput.current.value = "";
    setFileReading(false);
    setFileError("");
    setFileInfo("");
    setCredentialFiles([]);
  };
  useEffect(
    () => () => {
      fileReadVersion.current++;
    },
    [],
  );
  const loadCredentialFile = async (input: HTMLInputElement) => {
    const files = Array.from(input.files ?? []);
    clearFileSelection();
    form.setFieldValue("credentials", "");
    if (!files.length) return;
    const version = fileReadVersion.current;
    setFileReading(true);
    try {
      const loaded: CredentialFile[] = [];
      for (const file of files) {
        if (version !== fileReadVersion.current) return;
        let error = !/\.(json|txt)$/i.test(file.name)
          ? "请选择 .json 或 .txt 文件。"
          : file.size > 512 * 1024
            ? "文件不能超过 512 KiB。"
            : !file.size
              ? "文件为空，请选择包含凭据的文件。"
              : "";
        let contents = "";
        if (!error) {
          try {
            contents = await file.text();
            if (new TextEncoder().encode(contents).length > 512 * 1024)
              error = "凭据文本不能超过 512 KiB。";
            else if (!contents.trim())
              error = "文件为空，请选择包含凭据的文件。";
          } catch {
            error = "文件读取失败，请重新选择。";
          }
        }
        loaded.push({
          key: loaded.length,
          name: file.name,
          status: error ? "invalid" : "ready",
          credentials: error ? undefined : contents,
          error: error || undefined,
        });
      }
      if (version !== fileReadVersion.current) return;
      if (loaded.length === 1) {
        const file = loaded[0];
        if (file.error) setFileError(file.error);
        else {
          form.setFieldValue("credentials", file.credentials);
          setFileInfo("文件已加载到下方文本框；检查后点击确定才会提交。");
        }
      } else {
        setCredentialFiles(loaded);
      }
    } finally {
      if (version === fileReadVersion.current) setFileReading(false);
    }
  };
  const { message } = App.useApp();
  const writable = identity.role !== "readonly",
    superadmin = identity.role === "superadmin";
  useEffect(() => {
    setSelectedChannelIds([]);
    setChannelResult(null);
  }, [section]);
  const selectedChannels = result.data.filter(row => selectedChannelIds.includes(row.id));
  const selectedFor = (operation: ChannelBatchAction) => selectedChannels
    .filter(row => operation === "restore" ? !!row.archivedAt : !row.archivedAt)
    .map(row => row.id);
  const channelOperation = async <T,>(
    key: string,
    task: () => Promise<T>,
    describe: (response: T) => { text: string; warning: boolean },
    clearSelection = false,
  ) => {
    if (!superadmin || pending) return;
    setPending(key);
    setOperationError("");
    setChannelResult(null);
    try {
      const summary = describe(await task());
      setChannelResult(summary);
      if (summary.warning) message.warning(summary.text);
      else message.success(summary.text);
      if (clearSelection) setSelectedChannelIds([]);
      await query.refetch();
    } catch (error) {
      setOperationError(errorText(error));
      if ((error as any).statusCode === 401) onExpired();
    } finally {
      setPending("");
    }
  };
  const refreshCredits = (ids?: string[], key = "channel-credits-all") => {
    void channelOperation(key, () => refreshChannelCredits(ids), response => ({
      text: `积分刷新完成：检查 ${response.checked} 个，成功 ${response.succeeded} 个，失败 ${response.failed} 个。`,
      warning: response.failed > 0,
    }));
  };
  const cleanChannels = (ids?: string[]) => {
    void channelOperation("channel-cleanup", () => cleanupChannelAccounts(ids), response => ({
      text: `清理完成：检查 ${response.checked} 个，归档 ${response.archived} 个，保留 ${response.retained} 个，读取失败 ${response.failed} 个。`,
      warning: response.failed > 0,
    }), true);
  };
  const batchChannels = (operation: ChannelBatchAction) => {
    const ids = selectedFor(operation);
    if (!ids.length) return;
    void channelOperation(`channel-batch-${operation}`, () => batchChannelAccounts(ids, operation), response => ({
      text: `已${channelBatchNames[operation]} ${response.updated} 个账户。`,
      warning: false,
    }), true);
  };
  useEffect(() => {
    if (query.error?.statusCode === 401) onExpired();
  }, [query.error]);
  const run = async (
    key: string,
    task: () => Promise<unknown>,
    success: string,
  ) => {
    setPending(key);
    setOperationError("");
    try {
      const response = await task();
      message.success(success);
      void query.refetch();
      return response;
    } catch (error) {
      setOperationError(errorText(error));
      if ((error as any).statusCode === 401) onExpired();
      throw error;
    } finally {
      setPending("");
    }
  };
  const action = (
    key: string,
    task: () => Promise<unknown>,
    success: string,
  ) => {
    void run(key, task, success).catch(() => {});
  };
  const button = (
    r: Row,
    title: string,
    route: string,
    method: string,
    body: unknown,
    allowed: boolean,
    confirm: string,
  ) => (
    <Popconfirm
      title={confirm}
      onConfirm={() =>
        action(
          `${route}-${r.id}`,
          () =>
            mutation(
              `/api/admin/${route.replace(":id", encodeURIComponent(r.id))}`,
              method,
              body,
            ),
          "操作已完成",
        )
      }
    >
      <Button
        size="small"
        disabled={!allowed || !!pending}
        loading={pending === `${route}-${r.id}`}
      >
        {title}
      </Button>
    </Popconfirm>
  );
  const userColumns: ColumnsType<Row> = [
    {
      title: "账户",
      dataIndex: "email",
      render: (email, r) => (
        <Space>
          <Avatar icon={<UserOutlined />} />
          <div>
            <Text strong>{r.name || email}</Text>
            <br />
            <Text type="secondary">{email}</Text>
            <br />
            <Text className="small-id" type="secondary">
              {r.id}
            </Text>
          </div>
        </Space>
      ),
    },
    {
      title: "状态",
      render: (_, r) => (
        <Space orientation="vertical" size={3}>
          <Tag color={r.disabled ? "red" : "green"}>
            {r.disabled ? "已禁用" : "正常"}
          </Tag>
          <Text type="secondary">
            {r.emailVerified ? "邮箱已验证" : "邮箱未验证"}
          </Text>
        </Space>
      ),
    },
    { title: "激活有效期", dataIndex: "validUntil", render: date },
    {
      title: "共享资格",
      dataIndex: "sharingEligible",
      render: (v) => (
        <Tag color={v ? "blue" : "default"}>{v ? "已授权" : "未授权"}</Tag>
      ),
    },
    {
      title: "操作",
      width: 340,
      render: (_, r) => (
        <Space wrap>
          {button(
            r,
            r.disabled ? "启用" : "禁用",
            "users/:id",
            "PATCH",
            { disabled: !r.disabled },
            writable && (!r.role || superadmin),
            r.disabled ? "启用此账户？" : "禁用此账户？",
          )}
          {button(
            r,
            "撤销会话",
            "users/:id/revoke-sessions",
            "POST",
            {},
            writable && (!r.role || superadmin),
            "撤销此账户的全部会话？",
          )}
          {button(
            r,
            r.sharingEligible ? "移出白名单" : "加入白名单",
            "users/:id",
            "PATCH",
            { sharingEligible: !r.sharingEligible },
            writable && (!r.role || superadmin),
            "更新此账户共享资格？",
          )}
        </Space>
      ),
    },
  ];
  const columns: Record<string, ColumnsType<Row>> = {
    users: userColumns,
    "sharing-whitelist": userColumns,
    "activation-codes": [
      { title: "标识", dataIndex: "id", render: (v) => <Text code>{v}</Text> },
      { title: "状态", dataIndex: "status", render: tag },
      { title: "有效天数", dataIndex: "validityDays" },
      { title: "最晚兑换时间", dataIndex: "redeemBefore", render: date },
      { title: "兑换账户", dataIndex: "redeemedBy", render: (v) => v || "—" },
      { title: "备注", dataIndex: "note" },
      { title: "创建时间", dataIndex: "createdAt", render: date },
      {
        title: "操作",
        render: (_, r) =>
          button(
            r,
            "撤销",
            "activation-codes/:id/revoke",
            "POST",
            {},
            writable && r.status === "available",
            "撤销此激活码？撤销后无法兑换。",
          ),
      },
    ],
    admins: [
      { title: "账户", dataIndex: "email" },
      {
        title: "账户 ID",
        dataIndex: "id",
        render: (v) => <Text code>{v}</Text>,
      },
      {
        title: "角色",
        dataIndex: "role",
        render: (v: Role) => roleNames[v] || v,
      },
      {
        title: "操作",
        render: (_, r) => (
          <Space>
            <Select
              aria-label={`修改 ${r.email} 角色`}
              value={r.role}
              style={{ width: 145 }}
              disabled={!!pending || r.id === identity.id}
              options={Object.entries(roleNames).map(([value, label]) => ({
                value,
                label,
              }))}
              onChange={(role) =>
                Modal.confirm({
                  title: `修改 ${r.email} 的管理员角色？`,
                  onOk: () =>
                    run(
                      r.id,
                      () =>
                        mutation(
                          `/api/admin/admins/${encodeURIComponent(r.id)}`,
                          "PUT",
                          { role },
                        ),
                      "管理员角色已更新",
                    ),
                })
              }
            />
            {button(
              r,
              "移除",
              "admins/:id",
              "DELETE",
              undefined,
              superadmin && r.id !== identity.id,
              "移除此账户的管理员权限？",
            )}
          </Space>
        ),
      },
    ],
    audit: [
      { title: "时间", dataIndex: "createdAt", render: date },
      { title: "操作人", dataIndex: "actorId" },
      {
        title: "动作",
        dataIndex: "action",
        render: (v) => <Text code>{v}</Text>,
      },
      {
        title: "对象",
        render: (_, r) =>
          [r.targetType, r.targetId].filter(Boolean).join(" / ") || "—",
      },
      {
        title: "变更摘要",
        dataIndex: "metadata",
        render: (v) => (v && Object.keys(v).length ? JSON.stringify(v) : "—"),
      },
    ],
    "system-jobs": [
      {
        title: "任务 ID",
        dataIndex: "id",
        render: (v) => <Text code>{v}</Text>,
      },
      { title: "项目", dataIndex: "projectId" },
      {
        title: "目标",
        render: (_, r) =>
          r.target ? `${r.target.type} / ${r.target.id}` : "—",
      },
      { title: "状态", dataIndex: "status", render: tag },
      { title: "执行渠道", dataIndex: "executor" },
      { title: "尝试次数", dataIndex: "attempt" },
      { title: "错误类型", dataIndex: "errorCode", render: (v) => v || "—" },
      { title: "创建时间", dataIndex: "createdAt", render: date },
      { title: "更新时间", dataIndex: "updatedAt", render: date },
    ],
    projects: [
      {
        title: "项目 ID",
        dataIndex: "projectId",
        render: (v) => <Text code>{v}</Text>,
      },
      { title: "所有者", dataIndex: "ownerId" },
      {
        title: "共享状态",
        dataIndex: "shared",
        render: (v) => (
          <Tag color={v ? "blue" : "default"}>{v ? "已共享" : "未共享"}</Tag>
        ),
      },
      { title: "成员数", dataIndex: "members", render: (v) => v?.length ?? 0 },
      { title: "版本", dataIndex: "revision" },
      {
        title: "操作",
        render: (_, r) => (
          <Button size="small" onClick={() => setProject(r)}>
            成员权限
          </Button>
        ),
      },
    ],
    channels: [
      {
        title: "渠道账户",
        render: (_, r) => (
          <div>
            <Text strong>{r.label || r.id}</Text>
            <br />
            <Text className="small-id" type="secondary">
              {r.id}
            </Text>
          </div>
        ),
      },
      { title: "渠道", render: (_, r) => r.provider || r.channel || "miora" },
      {
        title: "状态",
        render: (_, r) => (
          <div className="channel-account-state">
            <Tag color={r.archivedAt ? "default" : r.enabled ? "green" : "orange"}>
              {r.archivedAt ? "已归档" : r.enabled ? "已启用" : "已停用"}
            </Tag>
            {r.archivedAt && (
              <Text type="secondary">
                {channelCleanupReasons[r.cleanupReason] || "历史归档，原因未记录"}
              </Text>
            )}
          </div>
        ),
      },
      { title: "积分", width: 170, render: (_, r) => <ChannelCredits account={r} /> },
      { title: "积分核对时间", dataIndex: "creditsCheckedAt", render: date },
      {
        title: "本地凭据检查",
        render: (_, r) =>
          ({
            imported: "已导入",
            expired: "已过期",
            "format-and-decryption-passed": "格式与解密检查通过",
          })[r.localCredentialStatus as string] || "尚未检查",
      },
      { title: "凭据到期时间", dataIndex: "credentialExpiresAt", render: date },
      {
        title: "最近错误",
        dataIndex: "lastErrorCode",
        render: (v) => v || "—",
      },
      { title: "更新时间", dataIndex: "updatedAt", render: date },
      {
        title: "操作",
        render: (_, r) => (
          <Space wrap>
            <Button
              size="small"
              disabled={!superadmin || !!pending || !!r.archivedAt}
              loading={pending === `channel-credits-${r.id}`}
              onClick={() => refreshCredits([r.id], `channel-credits-${r.id}`)}
            >
              刷新积分
            </Button>
            <Button size="small" onClick={() => setChannelJobs(r)}>
              关联任务
            </Button>
            {r.archivedAt ? (
              button(
                r,
                "恢复",
                "channels/accounts/:id/restore",
                "POST",
                {},
                superadmin,
                "恢复此归档渠道账户？",
              )
            ) : (
              <>
                {button(
                  r,
                  r.enabled ? "停用" : "启用",
                  "channels/accounts/:id",
                  "PATCH",
                  { enabled: !r.enabled },
                  superadmin,
                  "更改渠道账户状态？",
                )}
                <Button
                  size="small"
                  disabled={!superadmin || !!pending}
                  onClick={() => {
                    clearFileSelection();
                    form.resetFields();
                    form.setFieldsValue({ accountId: r.id, label: r.label });
                    setDialog("channel");
                  }}
                >
                  更新凭据
                </Button>
                {button(
                  r,
                  "归档",
                  "channels/accounts/:id",
                  "DELETE",
                  undefined,
                  superadmin,
                  "归档此渠道账户？后续可以恢复。",
                )}
              </>
            )}
          </Space>
        ),
      },
    ],
  };
  const open = (kind: string) => {
    setOperationError("");
    clearFileSelection();
    form.resetFields();
    setDialog(kind);
  };
  const submit = async (values: Row) => {
    if (fileReading || credentialSubmitting.current) return;
    if (dialog === "channel" && credentialFiles.length) {
      if (values.accountId?.trim()) {
        form.setFields([
          { name: "accountId", errors: ["批量导入时请留空更新账户 ID。"] },
        ]);
        return;
      }
      if (!readyFileCount) return;
      credentialSubmitting.current = true;
      setPending("submit");
      setOperationError("");
      const version = fileReadVersion.current;
      const files = credentialFiles.map((file) => ({ ...file }));
      const publish = () => {
        if (version === fileReadVersion.current)
          setCredentialFiles(files.map(({ credentials: _credentials, ...file }) => file));
      };
      let succeeded = 0;
      try {
        for (let index = 0; index < files.length; index++) {
          const file = files[index];
          if (file.status !== "ready") continue;
          if (version !== fileReadVersion.current) break;
          file.status = "importing";
          publish();
          try {
            await mutation("/api/admin/channels/accounts/miora/import", "POST", {
              credentials: file.credentials,
              label: values.label?.trim() || undefined,
            });
            file.status = "succeeded";
            succeeded++;
          } catch (error) {
            file.status = "failed";
            file.error = errorText(error);
            if ([401, 403].includes((error as any).statusCode)) {
              for (const remaining of files.slice(index + 1)) {
                if (remaining.status === "ready") {
                  remaining.status = "failed";
                  remaining.error = "管理权限已失效，未提交。";
                }
              }
              if ((error as any).statusCode === 401) onExpired();
              break;
            }
          } finally {
            file.credentials = undefined;
            publish();
          }
        }
        if (version === fileReadVersion.current) {
          const failed = files.filter((file) => file.status !== "succeeded").length;
          setFileInfo(
            `导入完成：成功 ${succeeded} 份，失败 ${failed} 份。新账户已自动启用，已有账户保留原状态。${failed ? "请重新选择失败文件后导入。" : ""}`,
          );
          if (succeeded) message.success(`已导入 ${succeeded} 份凭据`);
        }
      } finally {
        for (const file of files) file.credentials = undefined;
        publish();
        if (version === fileReadVersion.current) {
          form.setFieldValue("credentials", "");
          setPending("");
          void query.refetch();
        }
        credentialSubmitting.current = false;
      }
      return;
    }
    try {
      if (dialog === "codes") {
        const response = (await run(
          "submit",
          () =>
            mutation<{ data: Row[] }>("/api/admin/activation-codes", "POST", {
              ...values,
              redeemBefore: values.redeemBefore?.toISOString() ?? null,
            }),
          "激活码创建成功",
        )) as { data: Row[] };
        setCodes(response.data);
      } else if (dialog === "admin") {
        await run(
          "submit",
          () =>
            mutation(
              `/api/admin/admins/${encodeURIComponent(values.userId)}`,
              "PUT",
              { role: values.role },
            ),
          "管理员权限已授予",
        );
      } else if (dialog === "channel") {
        await run(
          "submit",
          () =>
            values.accountId
              ? mutation(
                  `/api/admin/channels/accounts/${encodeURIComponent(values.accountId)}`,
                  "PATCH",
                  {
                    credentials: values.credentials,
                    label: values.label?.trim() || undefined,
                  },
                )
              : mutation("/api/admin/channels/accounts/miora/import", "POST", {
                  credentials: values.credentials,
                  label: values.label?.trim() || undefined,
                }),
          "渠道凭据已导入",
        );
        clearFileSelection();
        form.resetFields();
      }
      setDialog("");
    } catch {
      if (dialog === "channel") {
        clearFileSelection();
        form.setFieldValue("credentials", "");
      }
    }
  };
  return (
    <>
      <div className="summary-grid">
        <Card size="small">
          <Statistic title="匹配记录" value={result.total ?? "—"} suffix="条" />
        </Card>
        <Card size="small">
          <Statistic
            title="当前权限"
            value={roleNames[identity.role]}
            styles={{ content: { fontSize: 21 } }}
          />
        </Card>
        <Card size="small">
          <Statistic
            title="数据来源"
            value="管理 API"
            styles={{ content: { fontSize: 21 } }}
          />
          <Text type="secondary">
            {query.isFetching
              ? "正在同步…"
              : query.isError
                ? "读取失败"
                : "已同步"}
          </Text>
        </Card>
      </div>
      {section === "channels" && (
        <Alert
          type="info"
          showIcon
          title="新导入的 Miora 账户自动启用，已有账户保留原状态。积分由服务器通过已配置代理查询；读取失败会保留上次成功的积分，不会按零处理。凭据仅由超级管理员导入，导入后输入会清空。"
          className="readonly-banner"
        />
      )}
      <Card className="resource-card">
        <div className="table-toolbar">
          <Space wrap>
            {!["projects", "system-jobs"].includes(section) && (
              <Input.Search
                aria-label="搜索记录"
                allowClear
                placeholder="搜索邮箱、标识或备注"
                style={{ width: 300 }}
                onSearch={(value) => {
                  setQ(value);
                  setPage(1);
                  setSelectedChannelIds([]);
                }}
              />
            )}
            <Button
              icon={<ReloadOutlined />}
              loading={query.isFetching}
              disabled={!!pending}
              onClick={() => void query.refetch()}
            >
              刷新
            </Button>
          </Space>
          <Space>
            {section === "activation-codes" && (
              <Button
                type="primary"
                disabled={!writable}
                onClick={() => open("codes")}
              >
                创建激活码
              </Button>
            )}
            {section === "admins" && (
              <Button type="primary" onClick={() => open("admin")}>
                授予管理员权限
              </Button>
            )}
            {section === "channels" && (
              <Button
                type="primary"
                disabled={!superadmin || !!pending}
                onClick={() => open("channel")}
              >
                导入 Miora 凭据
              </Button>
            )}
          </Space>
        </div>
        {section === "channels" && (
          <div className="channel-management">
            <div className="channel-batch-bar">
              <Space wrap>
                <Text strong>已选 {selectedChannelIds.length} 个</Text>
                <Text type="secondary">可全选当前页</Text>
                {(["enable", "disable", "archive", "restore"] as ChannelBatchAction[]).map(operation => (
                  <Popconfirm
                    key={operation}
                    title={`${channelBatchNames[operation]}选中的 ${selectedFor(operation).length} 个${operation === "restore" ? "已归档" : "未归档"}账户？`}
                    description={operation === "restore" ? "恢复后为停用状态，可再批量启用。" : operation === "archive" ? "归档后停止接收新任务，账户可恢复。" : undefined}
                    onConfirm={() => batchChannels(operation)}
                  >
                    <Button
                      danger={operation === "archive"}
                      disabled={!superadmin || !!pending || !selectedFor(operation).length}
                      loading={pending === `channel-batch-${operation}`}
                    >
                      批量{channelBatchNames[operation]}
                    </Button>
                  </Popconfirm>
                ))}
              </Space>
            </div>
            <Space wrap>
              <Button
                disabled={!superadmin || !!pending || !selectedChannels.some(row => !row.archivedAt)}
                loading={pending === "channel-credits-selected"}
                onClick={() => refreshCredits(selectedChannels.filter(row => !row.archivedAt).map(row => row.id), "channel-credits-selected")}
              >
                刷新选中积分
              </Button>
              <Button
                icon={<ReloadOutlined />}
                disabled={!superadmin || !!pending}
                loading={pending === "channel-credits-all"}
                onClick={() => refreshCredits()}
              >
                刷新全部积分
              </Button>
              <Popconfirm
                title={selectedChannelIds.length ? `清理选中的 ${selectedChannelIds.length} 个账户？` : "检查并清理全部未归档账户？"}
                description="归档不足当前模型最低生成额度，或已确认凭据失效的账户。网络或积分读取失败时保留账户，归档后可恢复。"
                onConfirm={() => cleanChannels(selectedChannelIds.length ? selectedChannelIds : undefined)}
              >
                <Button
                  danger
                  disabled={!superadmin || !!pending}
                  loading={pending === "channel-cleanup"}
                >
                  {selectedChannelIds.length ? "清理选中账户" : "清理无效账户"}
                </Button>
              </Popconfirm>
            </Space>
            <Text type="secondary" className="channel-management-note">
              批量状态操作仅处理当前页选中的适用账户；刷新全部积分与全部清理会检查所有未归档账户。
            </Text>
          </div>
        )}
        {section === "channels" && channelResult && (
          <Alert
            type={channelResult.warning ? "warning" : "success"}
            showIcon
            closable
            onClose={() => setChannelResult(null)}
            title={channelResult.text}
            style={{ marginBottom: 16 }}
          />
        )}
        {operationError && (
          <Alert
            type="error"
            showIcon
            closable
            onClose={() => setOperationError("")}
            title={operationError}
            style={{ marginBottom: 16 }}
          />
        )}
        {query.isError ? (
          <Result
            status={query.error?.statusCode === 403 ? "403" : "error"}
            title="无法读取此资源"
            subTitle={query.error?.message}
            extra={
              <Button onClick={() => void query.refetch()}>重新加载</Button>
            }
          />
        ) : (
          <Table<Row>
            rowKey={(r) => r.id || r.projectId}
            columns={columns[section]}
            dataSource={result.data}
            loading={query.isFetching}
            rowSelection={section === "channels" ? {
              selectedRowKeys: selectedChannelIds,
              onChange: keys => setSelectedChannelIds(keys.map(String)),
              getCheckboxProps: () => ({ disabled: !superadmin || !!pending }),
              columnWidth: 64,
            } : undefined}
            scroll={{ x: section === "channels" ? 1600 : 1000 }}
            pagination={{
              current: page,
              pageSize: size,
              total: result.total,
              showSizeChanger: true,
              showTotal: (n) => `共 ${n} 条`,
              onChange: (n, s) => {
                setPage(n);
                setSize(s);
                setSelectedChannelIds([]);
              },
            }}
            locale={{ emptyText: <Empty description="暂无匹配记录" /> }}
          />
        )}
      </Card>
      <Modal
        title={
          dialog === "codes"
            ? "创建激活码"
            : dialog === "admin"
              ? "授予管理员权限"
              : "导入 Miora 凭据"
        }
        open={!!dialog}
        onCancel={() => {
          if (!pending) {
            clearFileSelection();
            form.resetFields();
            setDialog("");
          }
        }}
        onOk={() => form.submit()}
        width={credentialFiles.length ? 640 : undefined}
        styles={dialog === "channel" ? {
          body: { maxHeight: "calc(100vh - 220px)", overflowY: "auto" },
        } : undefined}
        okText={
          credentialFiles.length
            ? `批量导入${readyFileCount ? `（${readyFileCount}）` : ""}`
            : "确定"
        }
        cancelText={
          credentialFiles.length && !readyFileCount && !pending ? "关闭" : "取消"
        }
        confirmLoading={pending === "submit" || fileReading}
        okButtonProps={{
          disabled:
            fileReading || !!pending ||
            (credentialFiles.length > 0 && !readyFileCount),
        }}
        cancelButtonProps={{ disabled: !!pending }}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ count: 1, validityDays: 365, role: "readonly" }}
          onFinish={submit}
        >
          {dialog === "codes" ? (
            <>
              <Paragraph type="secondary">
                激活期限从兑换成功后计算，最晚兑换时间单独限制兑换窗口。
              </Paragraph>
              <Form.Item name="count" label="数量" rules={[{ required: true }]}>
                <InputNumber min={1} max={100} />
              </Form.Item>
              <Form.Item
                name="validityDays"
                label="激活有效天数"
                rules={[{ required: true }]}
              >
                <InputNumber min={1} max={3650} />
              </Form.Item>
              <Form.Item name="redeemBefore" label="最晚兑换时间（可选）">
                <DatePicker showTime style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item name="note" label="备注">
                <Input.TextArea maxLength={500} showCount />
              </Form.Item>
            </>
          ) : dialog === "admin" ? (
            <>
              <Paragraph type="secondary">
                输入已存在的账户 ID。只有超级管理员可授予管理权限。
              </Paragraph>
              <Form.Item
                name="userId"
                label="账户 ID"
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
              <Form.Item name="role" label="角色">
                <Select
                  options={Object.entries(roleNames).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
              </Form.Item>
            </>
          ) : (
            <>
              <Alert
                type="warning"
                title="仅提交您有权使用的渠道账户凭据。凭据不会在管理列表中回显。"
                style={{ marginBottom: 16 }}
              />
              <Form.Item
                name="accountId"
                label="更新账户 ID（新导入留空）"
                rules={[
                  {
                    validator: (_, value) =>
                      credentialFiles.length && value?.trim()
                        ? Promise.reject(
                            new Error("批量导入时请留空更新账户 ID。"),
                          )
                        : Promise.resolve(),
                  },
                ]}
              >
                <Input disabled={!!pending || fileReading} />
              </Form.Item>
              <Form.Item name="label" label="账户标签">
                <Input maxLength={120} disabled={!!pending || fileReading} />
              </Form.Item>
              <Form.Item label="本地凭据文件（可选）">
                <input
                  ref={credentialFileInput}
                  type="file"
                  multiple
                  accept=".json,.txt"
                  aria-label="选择本地凭据文件"
                  disabled={!!pending || fileReading}
                  onChange={(event) =>
                    void loadCredentialFile(event.currentTarget)
                  }
                />
                <Paragraph
                  type="secondary"
                  style={{ marginTop: 8, marginBottom: 0 }}
                >
                  支持多选 .json/.txt 文件，每份最大 512 KiB；点击导入后提交。批量导入时账户 ID 留空，标签应用于全部文件。
                </Paragraph>
              </Form.Item>
              {fileReading && (
                <Spin size="small" description="正在读取文件…">
                  <div style={{ height: 24 }} />
                </Spin>
              )}
              {fileError && (
                <Alert
                  type="error"
                  showIcon
                  title={fileError}
                  style={{ marginBottom: 16 }}
                />
              )}
              {fileInfo && (
                <Alert
                  type="info"
                  showIcon
                  title={fileInfo}
                  style={{ marginBottom: 16 }}
                />
              )}
              {credentialFiles.length > 0 && (
                <>
                  <Paragraph>
                    已选择 {credentialFiles.length} 个文件
                    {readyFileCount ? `，待导入 ${readyFileCount} 份` : ""}
                    <Button
                      type="link"
                      disabled={!!pending || fileReading}
                      onClick={clearFileSelection}
                    >
                      清除文件
                    </Button>
                  </Paragraph>
                  <Table<CredentialFile>
                    size="small"
                    rowKey="key"
                    dataSource={credentialFiles}
                    pagination={false}
                    scroll={{ y: 240 }}
                    style={{ marginBottom: 16 }}
                    columns={[
                      {
                        title: "文件",
                        dataIndex: "name",
                        ellipsis: true,
                        width: "45%",
                      },
                      {
                        title: "导入状态",
                        render: (_, file) => (
                          <>
                            <Tag
                              color={file.status === "succeeded" ? "green" : file.error ? "red" : "blue"}
                            >
                              {{
                                ready: "待导入",
                                invalid: "文件无效",
                                importing: "正在导入",
                                succeeded: "导入成功",
                                failed: "导入失败",
                              }[file.status]}
                            </Tag>
                            {file.error && (
                              <Text type="danger">{file.error}</Text>
                            )}
                          </>
                        ),
                      },
                    ]}
                  />
                </>
              )}
              {!credentialFiles.length && (
                <Form.Item
                  name="credentials"
                  label="Miora 导出 JSON 或 Cookie 文本"
                  rules={[
                    { required: true, message: "请输入导出的凭据" },
                    {
                      validator: (_, value) =>
                        !value ||
                        new TextEncoder().encode(value).length <= 512 * 1024
                          ? Promise.resolve()
                          : Promise.reject(
                              new Error("凭据文本不能超过 512 KiB。"),
                            ),
                    },
                  ]}
                >
                  <Input.TextArea
                    rows={8}
                    disabled={fileReading || !!pending}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Form.Item>
              )}
            </>
          )}
        </Form>
        {operationError && <Alert type="error" title={operationError} />}
      </Modal>
      <Modal
        title={`关联任务 · ${channelJobs?.label || channelJobs?.id || ""}`}
        open={!!channelJobs}
        onCancel={() => setChannelJobs(null)}
        footer={<Button onClick={() => setChannelJobs(null)}>关闭</Button>}
        width={900}
        destroyOnHidden
      >
        {channelJobs && (
          <ChannelJobs key={channelJobs.id} account={channelJobs} />
        )}
      </Modal>
      <Modal
        title="请立即保存完整激活码"
        open={codes.length > 0}
        onCancel={() => setCodes([])}
        onOk={() => setCodes([])}
        okText="已保存，关闭"
        cancelButtonProps={{ style: { display: "none" } }}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          title="完整激活码仅显示本次，关闭后无法再次读取。"
        />
        <div className="codes-output">
          {codes.map((r) => (
            <Paragraph key={r.id} code copyable={{ text: r.code }}>
              {r.code}
            </Paragraph>
          ))}
        </div>
      </Modal>
      <Modal
        title="项目成员权限"
        open={!!project}
        onCancel={() => setProject(null)}
        footer={<Button onClick={() => setProject(null)}>关闭</Button>}
        width={720}
      >
        <Alert
          type="info"
          title="此处仅可撤销成员或将编辑者降为查看者。新增成员和提升权限须由项目所有者在共享白名单中操作。"
          style={{ marginBottom: 16 }}
        />
        <Table
          rowKey="userId"
          pagination={false}
          dataSource={project?.members}
          columns={[
            { title: "账户 ID", dataIndex: "userId" },
            { title: "项目角色", dataIndex: "role", render: tag },
            {
              title: "操作",
              render: (_, r: Row) => (
                <Space>
                  {r.role === "editor" && (
                    <Popconfirm
                      title="将此编辑者降为查看者？"
                      onConfirm={() => {
                        if (project)
                          action(
                            r.userId,
                            async () => {
                              const response = await mutation<{
                                members: Row[];
                              }>(
                                `/api/admin/projects/${encodeURIComponent(project.projectId)}/members/${encodeURIComponent(r.userId)}`,
                                "PUT",
                                { role: "viewer" },
                              );
                              setProject({
                                ...project,
                                members: response.members,
                              });
                            },
                            "成员已降为查看者",
                          );
                      }}
                    >
                      <Button
                        size="small"
                        disabled={
                          !project?.canManageMembers ||
                          !!pending ||
                          r.role !== "editor"
                        }
                      >
                        降为查看者
                      </Button>
                    </Popconfirm>
                  )}
                  <Popconfirm
                    title="移除此项目成员？"
                    onConfirm={() => {
                      if (project)
                        action(
                          r.userId,
                          async () => {
                            const response = await mutation<{ members: Row[] }>(
                              `/api/admin/projects/${encodeURIComponent(project.projectId)}/members/${encodeURIComponent(r.userId)}`,
                              "DELETE",
                            );
                            setProject({
                              ...project,
                              members: response.members,
                            });
                          },
                          "成员已移除",
                        );
                    }}
                  >
                    <Button
                      size="small"
                      danger
                      disabled={
                        !project?.canManageMembers ||
                        !!pending ||
                        r.role === "owner"
                      }
                    >
                      移除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
        {operationError && <Alert type="error" title={operationError} />}
      </Modal>
    </>
  );
}

function ChannelJobs({ account }: { account: Row }) {
  const [page, setPage] = useState(1);
  const { query, result } = useList<Row>({
    resource: `channels/accounts/${encodeURIComponent(account.id)}/jobs`,
    pagination: { currentPage: page, pageSize: 10 },
    queryOptions: { retry: false },
  });
  return (
    <>
      <Alert
        type="info"
        title="只显示任务状态和错误类型；任务输入、输出与原始渠道响应不在管理视图中展示。"
        style={{ marginBottom: 16 }}
      />
      {query.isError ? (
        <Alert
          type="error"
          showIcon
          title={query.error?.message}
          action={<Button onClick={() => void query.refetch()}>重试</Button>}
        />
      ) : (
        <Table<Row>
          rowKey="id"
          loading={query.isFetching}
          dataSource={result.data}
          scroll={{ x: 800 }}
          pagination={{
            current: page,
            pageSize: 10,
            total: result.total,
            onChange: setPage,
          }}
          columns={[
            {
              title: "任务 ID",
              dataIndex: "id",
              render: (v) => <Text code>{v}</Text>,
            },
            { title: "类型", dataIndex: "kind" },
            { title: "状态", dataIndex: "status", render: tag },
            {
              title: "结果状态",
              dataIndex: "resultAvailable",
              render: (v) => (v ? "已产生结果" : "暂无结果"),
            },
            {
              title: "错误类型",
              dataIndex: "errorCode",
              render: (v) => v || "—",
            },
            { title: "创建时间", dataIndex: "createdAt", render: date },
            { title: "更新时间", dataIndex: "updatedAt", render: date },
          ]}
        />
      )}
    </>
  );
}
