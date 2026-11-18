"use client";

import React, { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  usePlatformSnapshot,
  usePlatformMutations,
} from "@/hooks/usePlatformData";
import {
  patientRegistrationSchema,
  deviceRegistrationSchema,
  staffMemberSchema,
} from "@/lib/validations";
import {
  PTI_CLINIC_ID,
  PTI_CLINIC_NAME,
  USER_ROLE_LABELS,
  Patient,
} from "@/types/models";
import { hasPermission } from "@/lib/auth/rbac";
import { formatTimestamp } from "@/lib/utils";
import { NativeModalDialog } from "@/components/ui/NativeModalDialog";
import { VitalSignsChart } from "@/components/charts/VitalSignsChart";
import { Esp32HardwareConsole } from "@/components/iot/Esp32HardwareConsole";
import {
  Activity,
  Users,
  Cpu,
  AlertTriangle,
  Clock,
  Plus,
  CheckCircle2,
  XCircle,
  Building2,
  UserCheck,
  Settings,
  ClipboardList,
  HeartPulse,
  Thermometer,
  Wifi,
  ArrowLeft,
} from "lucide-react";

type NavigationTab =
  | "overview"
  | "patients"
  | "devices"
  | "sessions"
  | "measurements"
  | "staff"
  | "settings";

type PatientFormValues = z.infer<typeof patientRegistrationSchema>;
type DeviceFormValues = z.infer<typeof deviceRegistrationSchema>;
type StaffFormValues = z.infer<typeof staffMemberSchema>;

const SYNC_SHORT_LABELS: Record<string, string> = {
  verified_online: "Online",
  pending_offline: "Pending",
  verified_offline: "Verified",
  rejected: "Rejected",
};

const ALERT_SHORT_LABELS: Record<string, string> = {
  normal: "Normal",
  warning: "Warn",
  high_priority: "Alert",
};

export default function HospitalPlatformPage() {
  const [activeActorUid, setActiveActorUid] = useState<string>(
    "usr_hosp_admin_pti"
  );
  const [activeTab, setActiveTab] = useState<NavigationTab>("overview");
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(
    null
  );

  const [patientSearchQuery, setPatientSearchQuery] = useState<string>("");
  const [patientStatusFilter, setPatientStatusFilter] = useState<string>("all");
  const [measurementSyncFilter, setMeasurementSyncFilter] =
    useState<string>("all");
  const [deviceFilterId, setDeviceFilterId] = useState<string>("all");

  const [isRegisterPatientOpen, setIsRegisterPatientOpen] =
    useState<boolean>(false);
  const [isRegisterDeviceOpen, setIsRegisterDeviceOpen] =
    useState<boolean>(false);
  const [isAddStaffOpen, setIsAddStaffOpen] = useState<boolean>(false);

  const [newlyRegisteredPatient, setNewlyRegisteredPatient] =
    useState<Patient | null>(null);
  const [newlyProvisionedDevice, setNewlyProvisionedDevice] = useState<{
    deviceId: string;
    provisionedSecret: string;
  } | null>(null);
  const [actionBanner, setActionBanner] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const { data, isLoading, error } = usePlatformSnapshot(activeActorUid);
  const mutations = usePlatformMutations(activeActorUid);

  const patientForm = useForm<PatientFormValues>({
    resolver: zodResolver(patientRegistrationSchema),
    mode: "onBlur",
    defaultValues: {
      hospitalId: PTI_CLINIC_ID,
      fullName: "",
      dateOfBirth: "1985-05-15",
      sex: "female",
      ward: "Ward A",
      bedNumber: "A-15",
      assignedDoctorId: "usr_doctor_pti_1",
      assignedNurseId: "usr_nurse_pti_1",
      status: "stable",
      consentRecorded: true,
    },
  });

  const deviceForm = useForm<DeviceFormValues>({
    resolver: zodResolver(deviceRegistrationSchema),
    mode: "onBlur",
    defaultValues: {
      hospitalId: PTI_CLINIC_ID,
      serialNumber: "ESP32-PTI-004",
      macAddress: "24:6F:28:1A:B2:04",
      name: "Triage Monitor #4",
      ward: "OPD Triage",
      firmwareVersion: "v2.4.2",
      hardwareRevision: "ESP32-WROOM-32",
    },
  });

  const staffForm = useForm<StaffFormValues>({
    resolver: zodResolver(staffMemberSchema),
    mode: "onBlur",
    defaultValues: {
      email: "",
      displayName: "",
      role: "nurse",
      department: "Ward Nursing",
    },
  });

  if (isLoading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2.5 bg-slate-50 p-8">
        <progress className="w-48" aria-label="Loading PTI Clinic telemetry" />
        <p className="text-xs font-medium text-slate-500">
          Loading PTI Clinic telemetry…
        </p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <main className="mx-auto max-w-lg p-8">
        <div
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 p-5 text-rose-900"
        >
          <h1 className="text-sm font-bold">Authorization Error</h1>
          <p className="mt-1 text-xs">
            {error instanceof Error ? error.message : "Failed to load data."}
          </p>
          <button
            type="button"
            onClick={() => setActiveActorUid("usr_hosp_admin_pti")}
            className="mt-3 rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-600"
          >
            Reset Session
          </button>
        </div>
      </main>
    );
  }

  const {
    actor,
    currentHospital,
    users,
    patients,
    devices,
    sessions,
    measurements,
    members,
    auditLogs,
  } = data;

  const activeDevicesCount = devices.filter(
    (d) => d.status === "active" && d.connectionStatus !== "offline"
  ).length;
  const attentionPatients = patients.filter(
    (p) => p.status === "attention" || p.status === "critical"
  );
  const pendingOfflineMeasurements = measurements.filter(
    (m) => m.syncStatus === "pending_offline"
  );

  const filteredPatients = patients.filter((p) => {
    const matchesQuery =
      !patientSearchQuery.trim() ||
      p.fullName.toLowerCase().includes(patientSearchQuery.toLowerCase()) ||
      p.patientCode.includes(patientSearchQuery.trim()) ||
      p.ward.toLowerCase().includes(patientSearchQuery.toLowerCase());
    const matchesStatus =
      patientStatusFilter === "all" || p.status === patientStatusFilter;
    return matchesQuery && matchesStatus;
  });

  const filteredMeasurements = measurements.filter((m) => {
    const matchesSync =
      measurementSyncFilter === "all" || m.syncStatus === measurementSyncFilter;
    const matchesDevice =
      deviceFilterId === "all" || m.deviceId === deviceFilterId;
    return matchesSync && matchesDevice;
  });

  const selectedPatient = selectedPatientId
    ? patients.find((p) => p.id === selectedPatientId) || null
    : null;
  const selectedPatientMeasurements = selectedPatient
    ? measurements.filter((m) => m.patientId === selectedPatient.id)
    : [];

  const handlePatientRegisterSubmit = async (values: PatientFormValues) => {
    try {
      const res = await mutations.registerPatient.mutateAsync({
        ...values,
        hospitalId: PTI_CLINIC_ID,
      });
      setNewlyRegisteredPatient(res.patient);
      setIsRegisterPatientOpen(false);
      patientForm.reset({
        ...values,
        fullName: "",
        bedNumber: "",
      });
      setActionBanner({
        type: "success",
        message: `Registered ${res.patient.fullName} (Code: ${res.patient.patientCode}).`,
      });
    } catch (err: unknown) {
      setActionBanner({
        type: "error",
        message: err instanceof Error ? err.message : "Registration failed",
      });
    }
  };

  const handleDeviceRegisterSubmit = async (values: DeviceFormValues) => {
    try {
      const res = await mutations.registerDevice.mutateAsync({
        ...values,
        hospitalId: PTI_CLINIC_ID,
      });
      setNewlyProvisionedDevice({
        deviceId: res.device.deviceId,
        provisionedSecret: res.provisionedSecret,
      });
      setIsRegisterDeviceOpen(false);
      setActionBanner({
        type: "success",
        message: `Provisioned ${res.device.name} (${res.device.deviceId}).`,
      });
    } catch (err: unknown) {
      setActionBanner({
        type: "error",
        message: err instanceof Error ? err.message : "Provisioning failed",
      });
    }
  };

  const handleStaffAddSubmit = async (values: StaffFormValues) => {
    try {
      await mutations.addStaffMember.mutateAsync({
        staff: values,
      });
      setIsAddStaffOpen(false);
      staffForm.reset();
      setActionBanner({
        type: "success",
        message: `Added ${values.displayName} (${USER_ROLE_LABELS[values.role]}).`,
      });
    } catch (err: unknown) {
      setActionBanner({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to add staff",
      });
    }
  };

  return (
    <div className="min-h-screen bg-slate-50/80 text-slate-900">
      {/* Compact Header */}
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/90 backdrop-blur-md">
        <a
          href="#main-platform-heading"
          className="skip-link visually-hidden"
        >
          Skip to main content
        </a>

        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-2.5 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-700 text-white shadow-sm">
              <HeartPulse className="h-4 w-4" aria-hidden="true" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-extrabold tracking-tight text-slate-900">
                HealthOS
              </span>
              <span className="text-slate-300">/</span>
              <span className="text-xs font-semibold text-slate-700">
                {PTI_CLINIC_NAME}
              </span>
              <span className="hidden rounded-md bg-teal-50 px-1.5 py-0.5 text-[10px] font-bold text-teal-800 border border-teal-200 sm:inline-block">
                NDPA
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <label
              htmlFor="actor-role-switcher"
              className="hidden text-xs font-medium text-slate-500 sm:inline"
            >
              Staff:
            </label>
            <select
              id="actor-role-switcher"
              name="actorUid"
              value={activeActorUid}
              onChange={(e) => {
                setActiveActorUid(e.target.value);
                setSelectedPatientId(null);
              }}
              className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-800 hover:border-slate-300"
            >
              {users.map((u) => (
                <option key={u.uid} value={u.uid}>
                  {u.displayName} ({USER_ROLE_LABELS[u.role]})
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-5 px-4 py-5 sm:px-6 lg:grid-cols-12">
        {/* Sleek Sidebar Navigation */}
        <aside className="lg:col-span-3 xl:col-span-2">
          <nav
            aria-label="Primary"
            className="sticky top-16 space-y-1 rounded-2xl border border-slate-200/80 bg-white p-2.5 shadow-sm"
          >
            {(
              [
                {
                  id: "overview",
                  label: "Overview",
                  icon: Activity,
                },
                {
                  id: "patients",
                  label: "Patients",
                  badge: patients.length,
                  icon: Users,
                },
                {
                  id: "devices",
                  label: "Devices",
                  badge: devices.length,
                  icon: Cpu,
                },
                {
                  id: "sessions",
                  label: "Sessions",
                  badge:
                    pendingOfflineMeasurements.length > 0
                      ? pendingOfflineMeasurements.length
                      : undefined,
                  icon: Clock,
                },
                {
                  id: "measurements",
                  label: "Vitals Log",
                  icon: Thermometer,
                },
                {
                  id: "staff",
                  label: "Staff",
                  icon: UserCheck,
                },
                {
                  id: "settings",
                  label: "Settings",
                  icon: Settings,
                },
              ] as const
            ).map((item) => {
              const Icon = item.icon;
              const isCurrent = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setActiveTab(item.id);
                    if (item.id !== "patients") {
                      setSelectedPatientId(null);
                    }
                  }}
                  aria-current={isCurrent ? "page" : undefined}
                  className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs font-semibold transition ${
                    isCurrent
                      ? "bg-sky-700 text-white shadow-sm"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{item.label}</span>
                  </span>
                  {"badge" in item && item.badge !== undefined && (
                    <span
                      className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] font-bold ${
                        isCurrent
                          ? "bg-sky-800 text-sky-100"
                          : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </aside>

        {/* Main Content */}
        <main className="space-y-5 lg:col-span-9 xl:col-span-10">
          {/* Sleek Page Title Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1
                id="main-platform-heading"
                tabIndex={-1}
                className="text-lg font-extrabold tracking-tight text-slate-900 sm:text-xl"
              >
                {activeTab === "overview" && "Telemetry Overview"}
                {activeTab === "patients" &&
                  (selectedPatient ? selectedPatient.fullName : "Patients")}
                {activeTab === "devices" && "ESP32 Devices"}
                {activeTab === "sessions" && "Sessions & Offline Queue"}
                {activeTab === "measurements" && "Vitals History"}
                {activeTab === "staff" && "Clinic Staff"}
                {activeTab === "settings" && "Settings & Audit Trail"}
              </h1>
            </div>

            <div className="flex items-center gap-2">
              {hasPermission(actor.role, "patient:register") && (
                <button
                  type="button"
                  onClick={() => setIsRegisterPatientOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-sky-700 px-3 py-2 text-xs font-bold text-white shadow-sm hover:bg-sky-600"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  New Patient
                </button>
              )}
              {hasPermission(actor.role, "device:register") && (
                <button
                  type="button"
                  onClick={() => setIsRegisterDeviceOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm hover:bg-slate-50"
                >
                  <Cpu className="h-3.5 w-3.5 text-sky-700" aria-hidden="true" />
                  Add ESP32
                </button>
              )}
            </div>
          </div>

          {/* Compact Notification Banners */}
          {actionBanner && (
            <div
              role="status"
              aria-live="polite"
              className={`flex items-center justify-between rounded-xl border px-3.5 py-2.5 text-xs font-medium ${
                actionBanner.type === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : "border-rose-200 bg-rose-50 text-rose-900"
              }`}
            >
              <span>{actionBanner.message}</span>
              <button
                type="button"
                onClick={() => setActionBanner(null)}
                className="ml-4 text-xs font-bold opacity-75 hover:opacity-100"
              >
                Dismiss
              </button>
            </div>
          )}

          {newlyRegisteredPatient && (
            <div
              role="status"
              aria-live="polite"
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-300 bg-sky-50 px-4 py-3 text-xs text-slate-900"
            >
              <div className="flex items-center gap-3">
                <span className="font-bold">
                  {newlyRegisteredPatient.fullName}
                </span>
                <span>Keypad Code:</span>
                <code className="rounded bg-sky-900 px-2 py-0.5 font-mono text-sm font-bold text-white">
                  {newlyRegisteredPatient.patientCode}
                </code>
              </div>
              <button
                type="button"
                onClick={() => setNewlyRegisteredPatient(null)}
                className="rounded-lg border border-sky-300 bg-white px-2.5 py-1 font-semibold text-sky-900"
              >
                Done
              </button>
            </div>
          )}

          {newlyProvisionedDevice && (
            <div
              role="status"
              aria-live="polite"
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-teal-300 bg-teal-50 px-4 py-3 text-xs text-slate-900"
            >
              <div>
                <span className="font-bold">
                  {newlyProvisionedDevice.deviceId}
                </span>{" "}
                • NVS Secret:{" "}
                <code className="rounded bg-slate-900 px-2 py-0.5 font-mono text-amber-300">
                  {newlyProvisionedDevice.provisionedSecret}
                </code>
              </div>
              <button
                type="button"
                onClick={() => setNewlyProvisionedDevice(null)}
                className="rounded-lg border border-teal-300 bg-white px-2.5 py-1 font-semibold text-teal-900"
              >
                Done
              </button>
            </div>
          )}

          {/* TAB 1: OVERVIEW */}
          {activeTab === "overview" && (
            <div className="space-y-5">
              {/* Sleek 4 KPI Cards */}
              <section
                aria-label="Key metrics"
                className="grid grid-cols-2 gap-3.5 xl:grid-cols-4"
              >
                <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-500">
                      Patients
                    </span>
                    <Users
                      className="h-4 w-4 text-sky-600"
                      aria-hidden="true"
                    />
                  </div>
                  <p className="mt-1.5 text-2xl font-extrabold text-slate-900">
                    {patients.length}
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-500">
                      Online Units
                    </span>
                    <Wifi
                      className="h-4 w-4 text-emerald-600"
                      aria-hidden="true"
                    />
                  </div>
                  <p className="mt-1.5 text-2xl font-extrabold text-slate-900">
                    {activeDevicesCount}
                    <span className="text-sm font-medium text-slate-400">
                      /{devices.length}
                    </span>
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-500">
                      Alerts
                    </span>
                    <AlertTriangle
                      className="h-4 w-4 text-rose-600"
                      aria-hidden="true"
                    />
                  </div>
                  <p className="mt-1.5 text-2xl font-extrabold text-rose-600">
                    {attentionPatients.length}
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-500">
                      Pending Sync
                    </span>
                    <Clock
                      className="h-4 w-4 text-amber-600"
                      aria-hidden="true"
                    />
                  </div>
                  <p className="mt-1.5 text-2xl font-extrabold text-amber-600">
                    {pendingOfflineMeasurements.length}
                  </p>
                </div>
              </section>

              <Esp32HardwareConsole
                devices={devices}
                onMeasurementsUpdated={() => mutations.invalidate()}
              />

              <VitalSignsChart measurements={measurements} />

              {/* Compact 2-Column Triage + Fleet Cards */}
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                <section
                  aria-labelledby="attention-patients-heading"
                  className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <h2
                      id="attention-patients-heading"
                      className="text-sm font-bold text-slate-900"
                    >
                      Priority Patients
                    </h2>
                    <button
                      type="button"
                      onClick={() => setActiveTab("patients")}
                      className="text-xs font-semibold text-sky-700 hover:underline"
                    >
                      All patients →
                    </button>
                  </div>

                  {attentionPatients.length === 0 ? (
                    <p className="text-xs text-slate-500">
                      No active priority alerts.
                    </p>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {attentionPatients.map((pat) => (
                        <li
                          key={pat.id}
                          className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-xs font-bold text-slate-900">
                                {pat.fullName}
                              </span>
                              <span
                                className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                                  pat.status === "critical"
                                    ? "bg-rose-100 text-rose-800"
                                    : "bg-amber-100 text-amber-800"
                                }`}
                              >
                                {pat.status}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[11px] text-slate-500">
                              Code{" "}
                              <code className="font-mono font-semibold text-slate-700">
                                {pat.patientCode}
                              </code>{" "}
                              • {pat.ward} ({pat.bedNumber})
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedPatientId(pat.id);
                              setActiveTab("patients");
                            }}
                            aria-label={`View ${pat.fullName}`}
                            className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                          >
                            View
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section
                  aria-labelledby="device-connectivity-heading"
                  className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <h2
                      id="device-connectivity-heading"
                      className="text-sm font-bold text-slate-900"
                    >
                      ESP32 Fleet Status
                    </h2>
                    <button
                      type="button"
                      onClick={() => setActiveTab("devices")}
                      className="text-xs font-semibold text-sky-700 hover:underline"
                    >
                      All devices →
                    </button>
                  </div>

                  <ul className="divide-y divide-slate-100">
                    {devices.map((dev) => (
                      <li
                        key={dev.id}
                        className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0"
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-slate-900">
                              {dev.name}
                            </span>
                            <span
                              className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold capitalize ${
                                dev.connectionStatus === "online"
                                  ? "bg-emerald-100 text-emerald-800"
                                  : dev.connectionStatus === "degraded"
                                  ? "bg-amber-100 text-amber-800"
                                  : "bg-slate-100 text-slate-600"
                              }`}
                            >
                              {dev.connectionStatus}
                            </span>
                          </div>
                          <p className="mt-0.5 text-[11px] text-slate-500">
                            {dev.ward} • {dev.firmwareVersion}
                          </p>
                        </div>
                        <div className="text-right text-[11px] text-slate-500">
                          <span className="font-mono font-semibold text-slate-700">
                            {dev.batteryPct ?? 90}%
                          </span>{" "}
                          batt
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>

              {/* Clean 6-Column Recent Readings Table */}
              <div
                tabIndex={0}
                role="region"
                aria-labelledby="recent-measurements-caption"
                className="table-wrapper"
              >
                <table
                  style={
                    {
                      "--label-2": '"Code"',
                      "--label-3": '"HR"',
                      "--label-4": '"SpO₂"',
                      "--label-5": '"IR Temp"',
                      "--label-6": '"Status"',
                      "--label-7": '"Time"',
                    } as React.CSSProperties
                  }
                >
                  <caption id="recent-measurements-caption">
                    Recent Readings
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Patient</th>
                      <th scope="col">Code</th>
                      <th scope="col">HR</th>
                      <th scope="col">SpO₂</th>
                      <th scope="col">IR Temp</th>
                      <th scope="col">Status</th>
                      <th scope="col">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {measurements.slice(0, 6).map((m) => (
                      <tr key={m.id}>
                        <th scope="row" className="text-xs">
                          {m.patientName || m.patientId}
                        </th>
                        <td>
                          <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-slate-700">
                            {m.patientCodeAtCapture}
                          </code>
                        </td>
                        <td className="font-mono text-xs font-bold text-rose-600">
                          {m.heartRateBpm} bpm
                        </td>
                        <td className="font-mono text-xs font-bold text-sky-700">
                          {m.spo2Pct}%
                        </td>
                        <td className="font-mono text-xs font-bold text-amber-700">
                          {m.surfaceTempC.toFixed(1)} °C
                        </td>
                        <td>
                          <div className="abbr-swap inline-flex items-center gap-1.5">
                            <span
                              className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${
                                m.alertLevel === "high_priority"
                                  ? "bg-rose-100 text-rose-800"
                                  : m.alertLevel === "warning"
                                  ? "bg-amber-100 text-amber-800"
                                  : "bg-emerald-100 text-emerald-800"
                              }`}
                            >
                              <span className="long">
                                {ALERT_SHORT_LABELS[m.alertLevel]}
                              </span>
                              <span className="short" aria-hidden="true">
                                {ALERT_SHORT_LABELS[m.alertLevel]}
                              </span>
                            </span>
                            <span className="text-[11px] text-slate-500">
                              {SYNC_SHORT_LABELS[m.syncStatus]}
                            </span>
                          </div>
                        </td>
                        <td className="text-xs text-slate-500">
                          {formatTimestamp(m.capturedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 2: PATIENTS */}
          {activeTab === "patients" && (
            <div className="space-y-5">
              {selectedPatient ? (
                <div className="space-y-5">
                  <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
                    <button
                      type="button"
                      onClick={() => setSelectedPatientId(null)}
                      className="mb-3 inline-flex items-center gap-1 text-xs font-bold text-sky-700 hover:underline"
                    >
                      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                      All Patients
                    </button>

                    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-4">
                      <div>
                        <div className="flex items-center gap-2.5">
                          <h2 className="text-lg font-extrabold text-slate-900">
                            {selectedPatient.fullName}
                          </h2>
                          <span
                            className={`rounded-md px-2 py-0.5 text-[11px] font-bold uppercase ${
                              selectedPatient.status === "critical"
                                ? "bg-rose-100 text-rose-800"
                                : selectedPatient.status === "attention"
                                ? "bg-amber-100 text-amber-800"
                                : "bg-emerald-100 text-emerald-800"
                            }`}
                          >
                            {selectedPatient.status}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          DOB: {selectedPatient.dateOfBirth} •{" "}
                          <span className="capitalize">
                            {selectedPatient.sex}
                          </span>{" "}
                          • ID:{" "}
                          <code className="font-mono">
                            {selectedPatient.id}
                          </code>
                        </p>
                      </div>

                      <div className="rounded-xl border border-sky-200 bg-sky-50 px-3.5 py-2 text-right">
                        <span className="block text-[10px] font-bold uppercase text-sky-700">
                          Keypad Code
                        </span>
                        <span className="font-mono text-xl font-black tracking-widest text-sky-950">
                          {selectedPatient.patientCode}
                        </span>
                      </div>
                    </div>

                    <div className="mt-3.5 grid grid-cols-2 gap-4 text-xs sm:grid-cols-4">
                      <div>
                        <span className="text-slate-400">Location</span>
                        <p className="font-semibold text-slate-800">
                          {selectedPatient.ward} • {selectedPatient.bedNumber}
                        </p>
                      </div>
                      <div>
                        <span className="text-slate-400">Doctor</span>
                        <p className="font-semibold text-slate-800">
                          {selectedPatient.assignedDoctorName}
                        </p>
                      </div>
                      <div>
                        <span className="text-slate-400">Nurse</span>
                        <p className="font-semibold text-slate-800">
                          {selectedPatient.assignedNurseName}
                        </p>
                      </div>
                      <div>
                        <span className="text-slate-400">NDPA Consent</span>
                        <p className="font-semibold text-emerald-700">
                          {selectedPatient.consentRecorded ? "Verified" : "No"}
                        </p>
                      </div>
                    </div>
                  </div>

                  <VitalSignsChart
                    measurements={selectedPatientMeasurements}
                    title={`Vitals Trend — ${selectedPatient.fullName}`}
                  />

                  <div
                    tabIndex={0}
                    role="region"
                    aria-labelledby="patient-detail-measurements-caption"
                    className="table-wrapper"
                  >
                    <table
                      style={
                        {
                          "--label-2": '"Device"',
                          "--label-3": '"HR"',
                          "--label-4": '"SpO₂"',
                          "--label-5": '"IR Temp"',
                          "--label-6": '"Status"',
                        } as React.CSSProperties
                      }
                    >
                      <caption id="patient-detail-measurements-caption">
                        Patient Readings ({selectedPatientMeasurements.length})
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Time</th>
                          <th scope="col">Device</th>
                          <th scope="col">HR</th>
                          <th scope="col">SpO₂</th>
                          <th scope="col">IR Temp</th>
                          <th scope="col">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedPatientMeasurements.map((m) => (
                          <tr key={m.id}>
                            <th scope="row" className="text-xs">
                              {formatTimestamp(m.capturedAt)}
                            </th>
                            <td className="text-xs text-slate-600">
                              {m.deviceName || m.deviceId}
                            </td>
                            <td className="font-mono text-xs font-bold text-rose-600">
                              {m.heartRateBpm} bpm
                            </td>
                            <td className="font-mono text-xs font-bold text-sky-700">
                              {m.spo2Pct}%
                            </td>
                            <td className="font-mono text-xs font-bold text-amber-700">
                              {m.surfaceTempC.toFixed(1)} °C
                            </td>
                            <td>
                              <span
                                className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${
                                  m.alertLevel === "high_priority"
                                    ? "bg-rose-100 text-rose-800"
                                    : m.alertLevel === "warning"
                                    ? "bg-amber-100 text-amber-800"
                                    : "bg-emerald-100 text-emerald-800"
                                }`}
                              >
                                {ALERT_SHORT_LABELS[m.alertLevel]}
                              </span>
                              <span className="ml-1.5 text-[11px] text-slate-500">
                                {SYNC_SHORT_LABELS[m.syncStatus]}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <>
                  <search className="rounded-2xl border border-slate-200/80 bg-white p-3.5 shadow-sm">
                    <form
                      action="/patients"
                      method="GET"
                      onSubmit={(e) => e.preventDefault()}
                      className="grid grid-cols-1 gap-3 sm:grid-cols-12"
                    >
                      <div className="sm:col-span-8">
                        <label
                          htmlFor="patient-search-input"
                          className="sr-only"
                        >
                          Search patients
                        </label>
                        <input
                          id="patient-search-input"
                          name="q"
                          type="search"
                          value={patientSearchQuery}
                          onChange={(e) =>
                            setPatientSearchQuery(e.target.value)
                          }
                          autoCorrect="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          placeholder="Search name, 6-digit code, or ward…"
                          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs"
                        />
                      </div>

                      <div className="sm:col-span-4">
                        <label
                          htmlFor="patient-status-filter"
                          className="sr-only"
                        >
                          Filter by status
                        </label>
                        <select
                          id="patient-status-filter"
                          name="status"
                          value={patientStatusFilter}
                          onChange={(e) =>
                            setPatientStatusFilter(e.target.value)
                          }
                          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium"
                        >
                          <option value="all">All Statuses</option>
                          <option value="critical">Critical</option>
                          <option value="attention">Attention</option>
                          <option value="stable">Stable</option>
                          <option value="discharged">Discharged</option>
                        </select>
                      </div>
                    </form>
                  </search>

                  {/* Clean 6-Column Patient Table */}
                  <div
                    tabIndex={0}
                    role="region"
                    aria-labelledby="patient-directory-caption"
                    className="table-wrapper"
                  >
                    <table
                      style={
                        {
                          "--label-2": '"Code"',
                          "--label-3": '"Ward / Bed"',
                          "--label-4": '"Clinician"',
                          "--label-5": '"Status"',
                          "--label-6": '"Action"',
                        } as React.CSSProperties
                      }
                    >
                      <caption id="patient-directory-caption">
                        Patient Directory ({filteredPatients.length})
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Patient</th>
                          <th scope="col">Code</th>
                          <th scope="col">Ward / Bed</th>
                          <th scope="col">Clinician</th>
                          <th scope="col">Status</th>
                          <th scope="col">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredPatients.map((p) => (
                          <tr key={p.id}>
                            <th scope="row">
                              <div className="text-xs font-bold text-slate-900">
                                {p.fullName}
                              </div>
                            </th>
                            <td>
                              <code className="rounded bg-sky-50 px-2 py-0.5 font-mono text-xs font-bold text-sky-900 border border-sky-200">
                                {p.patientCode}
                              </code>
                            </td>
                            <td className="text-xs text-slate-700">
                              {p.ward} •{" "}
                              <span className="font-semibold">
                                {p.bedNumber}
                              </span>
                            </td>
                            <td className="text-xs text-slate-600">
                              {p.assignedDoctorName}
                            </td>
                            <td>
                              <span
                                className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-bold uppercase ${
                                  p.status === "critical"
                                    ? "bg-rose-100 text-rose-800"
                                    : p.status === "attention"
                                    ? "bg-amber-100 text-amber-800"
                                    : "bg-emerald-100 text-emerald-800"
                                }`}
                              >
                                {p.status}
                              </span>
                            </td>
                            <td>
                              <button
                                type="button"
                                onClick={() => setSelectedPatientId(p.id)}
                                aria-label={`Open profile for ${p.fullName}`}
                                className="rounded-lg bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-slate-800"
                              >
                                Open
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}

          {/* TAB 3: DEVICES */}
          {activeTab === "devices" && (
            <div
              tabIndex={0}
              role="region"
              aria-labelledby="devices-table-caption"
              className="table-wrapper"
            >
              <table
                style={
                  {
                    "--label-2": '"Serial"',
                    "--label-3": '"Ward"',
                    "--label-4": '"FW / Batt"',
                    "--label-5": '"Link"',
                    "--label-6": '"Action"',
                  } as React.CSSProperties
                }
              >
                <caption id="devices-table-caption">
                  ESP32 Monitoring Units ({devices.length})
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Device</th>
                    <th scope="col">Serial</th>
                    <th scope="col">Ward</th>
                    <th scope="col">FW / Batt</th>
                    <th scope="col">Link</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.map((d) => (
                    <tr key={d.id}>
                      <th scope="row" className="text-xs font-bold">
                        {d.name}
                      </th>
                      <td className="font-mono text-xs text-slate-600">
                        {d.serialNumber}
                      </td>
                      <td className="text-xs text-slate-700">{d.ward}</td>
                      <td className="font-mono text-xs text-slate-600">
                        {d.firmwareVersion} • {d.batteryPct ?? 90}%
                      </td>
                      <td>
                        <span
                          className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-semibold capitalize ${
                            d.status !== "active"
                              ? "bg-rose-100 text-rose-800"
                              : d.connectionStatus === "online"
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-amber-100 text-amber-800"
                          }`}
                        >
                          {d.status !== "active"
                            ? d.status
                            : d.connectionStatus}
                        </span>
                      </td>
                      <td>
                        {hasPermission(actor.role, "device:operate") ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                mutations.updateDeviceStatus.mutate({
                                  deviceId: d.deviceId,
                                  status:
                                    d.status === "active"
                                      ? "inactive"
                                      : "active",
                                })
                              }
                              aria-label={`${
                                d.status === "active"
                                  ? "Deactivate"
                                  : "Activate"
                              } ${d.name}`}
                              className={`rounded-lg px-2.5 py-1 text-xs font-semibold text-white ${
                                d.status === "active"
                                  ? "bg-rose-600 hover:bg-rose-500"
                                  : "bg-emerald-600 hover:bg-emerald-500"
                              }`}
                            >
                              {d.status === "active" ? "Disable" : "Enable"}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDeviceFilterId(d.deviceId);
                                setActiveTab("measurements");
                              }}
                              aria-label={`View logs for ${d.name}`}
                              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              Logs
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400">Read</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* TAB 4: SESSIONS & OFFLINE VERIFICATION */}
          {activeTab === "sessions" && (
            <div className="space-y-5">
              {pendingOfflineMeasurements.length > 0 && (
                <section
                  aria-labelledby="offline-verification-heading"
                  className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 shadow-sm"
                >
                  <h2
                    id="offline-verification-heading"
                    className="mb-2.5 text-xs font-bold uppercase tracking-wider text-amber-900"
                  >
                    Pending Offline Readings ({pendingOfflineMeasurements.length}
                    )
                  </h2>
                  <div className="space-y-2">
                    {pendingOfflineMeasurements.map((m) => (
                      <div
                        key={m.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-white px-3.5 py-2.5 text-xs"
                      >
                        <div className="flex flex-wrap items-center gap-2.5">
                          <span className="font-bold text-slate-900">
                            {m.patientName}
                          </span>
                          <code className="rounded bg-amber-100 px-1.5 py-0.5 font-mono font-bold text-amber-900">
                            {m.patientCodeAtCapture}
                          </code>
                          <span className="font-mono text-slate-600">
                            {m.heartRateBpm} bpm • {m.spo2Pct}% •{" "}
                            {m.surfaceTempC.toFixed(1)} °C
                          </span>
                          <span className="text-slate-400">
                            {formatTimestamp(m.capturedAt)}
                          </span>
                        </div>

                        {hasPermission(
                          actor.role,
                          "measurement:verify_offline"
                        ) ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                mutations.verifyOfflineMeasurement.mutate({
                                  measurementId: m.measurementId,
                                  decision: "verified_offline",
                                })
                              }
                              aria-label={`Verify reading ${m.measurementId}`}
                              className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-emerald-500"
                            >
                              <CheckCircle2
                                className="h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                              Verify
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                mutations.verifyOfflineMeasurement.mutate({
                                  measurementId: m.measurementId,
                                  decision: "rejected",
                                  rejectionReason: "Rejected in review",
                                })
                              }
                              aria-label={`Reject reading ${m.measurementId}`}
                              className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-rose-500"
                            >
                              <XCircle
                                className="h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                              Reject
                            </button>
                          </div>
                        ) : (
                          <span className="text-[11px] text-slate-400">
                            Clinician required
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <div
                tabIndex={0}
                role="region"
                aria-labelledby="sessions-table-caption"
                className="table-wrapper"
              >
                <table
                  style={
                    {
                      "--label-2": '"Code"',
                      "--label-3": '"Device"',
                      "--label-4": '"Operator"',
                      "--label-5": '"Status"',
                      "--label-6": '"Time"',
                    } as React.CSSProperties
                  }
                >
                  <caption id="sessions-table-caption">
                    Measurement Sessions ({sessions.length})
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Patient</th>
                      <th scope="col">Code</th>
                      <th scope="col">Device</th>
                      <th scope="col">Operator</th>
                      <th scope="col">Status</th>
                      <th scope="col">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => (
                      <tr key={s.id}>
                        <th scope="row" className="text-xs font-bold">
                          {s.patientName || s.patientId}
                        </th>
                        <td>
                          <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-semibold">
                            {s.patientCode}
                          </code>
                        </td>
                        <td className="text-xs text-slate-600">
                          {s.deviceName || s.deviceId}
                        </td>
                        <td className="text-xs text-slate-600">
                          {s.operatorName || s.operatorId}
                        </td>
                        <td>
                          <span
                            className={`rounded-md px-2 py-0.5 text-[11px] font-bold capitalize ${
                              s.status === "completed"
                                ? "bg-emerald-100 text-emerald-800"
                                : s.status === "authorized"
                                ? "bg-sky-100 text-sky-800"
                                : "bg-slate-100 text-slate-600"
                            }`}
                          >
                            {s.status}
                          </span>
                        </td>
                        <td className="text-xs text-slate-500">
                          {formatTimestamp(s.completedAt || s.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 5: VITALS LOG */}
          {activeTab === "measurements" && (
            <div className="space-y-5">
              <search className="rounded-2xl border border-slate-200/80 bg-white p-3.5 shadow-sm">
                <form
                  action="/measurements"
                  method="GET"
                  onSubmit={(e) => e.preventDefault()}
                  className="grid grid-cols-1 gap-3 sm:grid-cols-12"
                >
                  <div className="sm:col-span-5">
                    <label htmlFor="meas-sync-filter" className="sr-only">
                      Sync state
                    </label>
                    <select
                      id="meas-sync-filter"
                      name="syncStatus"
                      value={measurementSyncFilter}
                      onChange={(e) => setMeasurementSyncFilter(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium"
                    >
                      <option value="all">All Sync States</option>
                      <option value="verified_online">Online</option>
                      <option value="pending_offline">Pending Offline</option>
                      <option value="verified_offline">Verified Offline</option>
                      <option value="rejected">Rejected</option>
                    </select>
                  </div>

                  <div className="sm:col-span-5">
                    <label htmlFor="meas-device-filter" className="sr-only">
                      ESP32 Device
                    </label>
                    <select
                      id="meas-device-filter"
                      name="deviceId"
                      value={deviceFilterId}
                      onChange={(e) => setDeviceFilterId(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium"
                    >
                      <option value="all">All Devices</option>
                      {devices.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="sm:col-span-2">
                    <button
                      type="button"
                      onClick={() => {
                        setMeasurementSyncFilter("all");
                        setDeviceFilterId("all");
                      }}
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100"
                    >
                      Reset
                    </button>
                  </div>
                </form>
              </search>

              <VitalSignsChart measurements={filteredMeasurements} />

              <div
                tabIndex={0}
                role="region"
                aria-labelledby="full-measurements-caption"
                className="table-wrapper"
              >
                <table
                  style={
                    {
                      "--label-2": '"Device"',
                      "--label-3": '"HR"',
                      "--label-4": '"SpO₂"',
                      "--label-5": '"IR Temp"',
                      "--label-6": '"Status"',
                      "--label-7": '"Time"',
                    } as React.CSSProperties
                  }
                >
                  <caption id="full-measurements-caption">
                    Vitals Telemetry Log ({filteredMeasurements.length})
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Patient</th>
                      <th scope="col">Device</th>
                      <th scope="col">HR</th>
                      <th scope="col">SpO₂</th>
                      <th scope="col">IR Temp</th>
                      <th scope="col">Status</th>
                      <th scope="col">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredMeasurements.map((m) => (
                      <tr key={m.id}>
                        <th scope="row" className="text-xs">
                          <span className="font-bold">{m.patientName}</span>{" "}
                          <code className="ml-1 font-mono text-[11px] text-slate-400">
                            #{m.patientCodeAtCapture}
                          </code>
                        </th>
                        <td className="text-xs text-slate-600">
                          {m.deviceName || m.deviceId}
                        </td>
                        <td className="font-mono text-xs font-bold text-rose-600">
                          {m.heartRateBpm} bpm
                        </td>
                        <td className="font-mono text-xs font-bold text-sky-700">
                          {m.spo2Pct}%
                        </td>
                        <td className="font-mono text-xs font-bold text-amber-700">
                          {m.surfaceTempC.toFixed(1)} °C
                        </td>
                        <td>
                          <span
                            className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${
                              m.alertLevel === "high_priority"
                                ? "bg-rose-100 text-rose-800"
                                : m.alertLevel === "warning"
                                ? "bg-amber-100 text-amber-800"
                                : "bg-emerald-100 text-emerald-800"
                            }`}
                          >
                            {ALERT_SHORT_LABELS[m.alertLevel]}
                          </span>
                          <span className="ml-1.5 text-[11px] text-slate-500">
                            {SYNC_SHORT_LABELS[m.syncStatus]}
                          </span>
                        </td>
                        <td className="text-xs text-slate-500">
                          {formatTimestamp(m.capturedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 6: STAFF */}
          {activeTab === "staff" && (
            <div className="space-y-4">
              {hasPermission(actor.role, "hospital:manage_staff") && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setIsAddStaffOpen(true)}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-sky-700 px-3 py-2 text-xs font-bold text-white hover:bg-sky-600"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    Add Staff
                  </button>
                </div>
              )}

              <div
                tabIndex={0}
                role="region"
                aria-labelledby="staff-table-caption"
                className="table-wrapper"
              >
                <table
                  style={
                    {
                      "--label-2": '"Role"',
                      "--label-3": '"Dept"',
                      "--label-4": '"Email"',
                      "--label-5": '"Status"',
                    } as React.CSSProperties
                  }
                >
                  <caption id="staff-table-caption">
                    PTI Clinic Staff ({members.length})
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Role</th>
                      <th scope="col">Dept</th>
                      <th scope="col">Email</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((mem) => (
                      <tr key={mem.id}>
                        <th scope="row" className="text-xs font-bold">
                          {mem.displayName}
                        </th>
                        <td>
                          <span className="rounded-md bg-sky-50 px-2 py-0.5 text-[11px] font-bold text-sky-900 border border-sky-200">
                            {USER_ROLE_LABELS[mem.role]}
                          </span>
                        </td>
                        <td className="text-xs text-slate-600">
                          {mem.department}
                        </td>
                        <td className="text-xs text-slate-500">{mem.email}</td>
                        <td>
                          <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                            {mem.active ? "Active" : "Suspended"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 7: SETTINGS & AUDIT */}
          {activeTab === "settings" && currentHospital && (
            <div className="space-y-5">
              <section
                aria-labelledby="hospital-settings-heading"
                className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm"
              >
                <div className="mb-3 flex items-center gap-2">
                  <Building2
                    className="h-4 w-4 text-sky-700"
                    aria-hidden="true"
                  />
                  <h2
                    id="hospital-settings-heading"
                    className="text-sm font-bold text-slate-900"
                  >
                    PTI Clinic Thresholds &amp; NDPA Policy
                  </h2>
                </div>

                <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
                  <div className="rounded-xl border border-slate-100 bg-slate-50 p-3.5">
                    <span className="text-slate-400">DPO &amp; Retention</span>
                    <p className="mt-1 font-mono font-bold text-slate-900">
                      {currentHospital.ndpaDpoEmail}
                    </p>
                    <p className="mt-0.5 text-slate-500">
                      {currentHospital.retentionDays} days retention
                    </p>
                  </div>

                  <div className="rounded-xl border border-slate-100 bg-slate-50 p-3.5">
                    <span className="text-slate-400">MAX30102 Reference</span>
                    <p className="mt-1 font-mono font-bold text-slate-900">
                      HR {currentHospital.alertThresholds.heartRateMinBpm}–
                      {currentHospital.alertThresholds.heartRateMaxBpm} bpm
                    </p>
                    <p className="mt-0.5 text-slate-500">
                      SpO₂ Warn &lt;
                      {currentHospital.alertThresholds.spo2MinPct}% • Alert &lt;
                      {currentHospital.alertThresholds.spo2CriticalPct}%
                    </p>
                  </div>

                  <div className="rounded-xl border border-slate-100 bg-slate-50 p-3.5">
                    <span className="text-slate-400">
                      MLX90614 IR Reference
                    </span>
                    <p className="mt-1 font-mono font-bold text-slate-900">
                      {currentHospital.alertThresholds.surfaceTempMinC.toFixed(
                        1
                      )}
                      –
                      {currentHospital.alertThresholds.surfaceTempMaxC.toFixed(
                        1
                      )}{" "}
                      °C
                    </p>
                    <p className="mt-0.5 text-slate-500">
                      Surface IR (non-core)
                    </p>
                  </div>
                </div>
              </section>

              <section aria-labelledby="audit-logs-heading">
                <h2 id="audit-logs-heading" className="sr-only">
                  Audit Logs
                </h2>
                {!hasPermission(actor.role, "hospital:view_audit_logs") ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
                    Switch to <strong>Hospital Admin</strong> or{" "}
                    <strong>Super Admin</strong> to view audit logs.
                  </div>
                ) : (
                  <div
                    tabIndex={0}
                    role="region"
                    aria-labelledby="audit-table-caption"
                    className="table-wrapper"
                  >
                    <table
                      style={
                        {
                          "--label-2": '"Actor"',
                          "--label-3": '"Target"',
                          "--label-4": '"Time"',
                        } as React.CSSProperties
                      }
                    >
                      <caption id="audit-table-caption">
                        Security Audit Trail ({auditLogs.length})
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Action</th>
                          <th scope="col">Actor</th>
                          <th scope="col">Target</th>
                          <th scope="col">Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {auditLogs.map((log) => (
                          <tr key={log.id}>
                            <th scope="row" className="font-mono text-xs">
                              {log.action}
                            </th>
                            <td className="font-mono text-xs text-slate-600">
                              {log.actorUid}{" "}
                              <span className="text-slate-400">
                                ({log.actorRole})
                              </span>
                            </td>
                            <td className="font-mono text-xs text-slate-600">
                              {log.targetCollection}/{log.targetId}
                            </td>
                            <td className="text-xs text-slate-500">
                              {formatTimestamp(log.createdAt)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          )}
        </main>
      </div>

      {/* MODAL 1: Register Patient */}
      <NativeModalDialog
        open={isRegisterPatientOpen}
        onClose={() => setIsRegisterPatientOpen(false)}
        title="New Patient"
        description="Assigns a unique 6-digit keypad code for PTI Clinic."
      >
        <form
          method="POST"
          action="/api/platform"
          onSubmit={patientForm.handleSubmit(handlePatientRegisterSubmit)}
          className="space-y-3.5"
        >
          <div>
            <label
              htmlFor="reg-full-name"
              className="block text-xs font-bold text-slate-800"
            >
              Full Name <span aria-hidden="true">*</span>
            </label>
            <input
              id="reg-full-name"
              type="text"
              autoComplete="name"
              required
              aria-invalid={
                patientForm.formState.errors.fullName ? "true" : undefined
              }
              aria-describedby={
                patientForm.formState.errors.fullName
                  ? "reg-full-name-error"
                  : undefined
              }
              {...patientForm.register("fullName")}
              className="health-form-control mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            {patientForm.formState.errors.fullName && (
              <p
                id="reg-full-name-error"
                className="mt-1 text-xs font-semibold text-rose-700"
              >
                {patientForm.formState.errors.fullName.message}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <div>
              <label
                htmlFor="reg-dob"
                className="block text-xs font-bold text-slate-800"
              >
                DOB <span aria-hidden="true">*</span>
              </label>
              <input
                id="reg-dob"
                type="date"
                required
                {...patientForm.register("dateOfBirth")}
                className="health-form-control mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <fieldset>
              <legend className="block text-xs font-bold text-slate-800">
                Sex <span aria-hidden="true">*</span>
              </legend>
              <div className="mt-2 flex items-center gap-4 text-xs">
                {(["female", "male", "other"] as const).map((sexOpt) => (
                  <span
                    key={sexOpt}
                    className="inline-flex items-center gap-1.5"
                  >
                    <input
                      id={`sex-${sexOpt}`}
                      type="radio"
                      value={sexOpt}
                      {...patientForm.register("sex")}
                    />
                    <label htmlFor={`sex-${sexOpt}`} className="capitalize">
                      {sexOpt}
                    </label>
                  </span>
                ))}
              </div>
            </fieldset>
          </div>

          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <div>
              <label
                htmlFor="reg-ward"
                className="block text-xs font-bold text-slate-800"
              >
                Ward <span aria-hidden="true">*</span>
              </label>
              <input
                id="reg-ward"
                type="text"
                required
                {...patientForm.register("ward")}
                className="health-form-control mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label
                htmlFor="reg-bed"
                className="block text-xs font-bold text-slate-800"
              >
                Bed <span aria-hidden="true">*</span>
              </label>
              <input
                id="reg-bed"
                type="text"
                required
                {...patientForm.register("bedNumber")}
                className="health-form-control mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
            <input
              id="reg-ndpa-consent"
              type="checkbox"
              required
              {...patientForm.register("consentRecorded")}
              className="mt-0.5 h-4 w-4"
            />
            <label
              htmlFor="reg-ndpa-consent"
              className="text-xs text-slate-700"
            >
              NDPA health-data consent recorded.
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsRegisterPatientOpen(false)}
              className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-bold text-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutations.registerPatient.isPending}
              className="rounded-lg bg-sky-700 px-3.5 py-2 text-xs font-bold text-white hover:bg-sky-600 disabled:opacity-50"
            >
              Register
            </button>
          </div>
        </form>
      </NativeModalDialog>

      {/* MODAL 2: Add ESP32 Device */}
      <NativeModalDialog
        open={isRegisterDeviceOpen}
        onClose={() => setIsRegisterDeviceOpen(false)}
        title="Add ESP32 Unit"
        description="Generates a one-time HMAC device secret."
      >
        <form
          method="POST"
          action="/api/platform"
          onSubmit={deviceForm.handleSubmit(handleDeviceRegisterSubmit)}
          className="space-y-3.5"
        >
          <div>
            <label
              htmlFor="dev-name"
              className="block text-xs font-bold text-slate-800"
            >
              Name <span aria-hidden="true">*</span>
            </label>
            <input
              id="dev-name"
              type="text"
              required
              {...deviceForm.register("name")}
              className="health-form-control mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <div>
              <label
                htmlFor="dev-serial"
                className="block text-xs font-bold text-slate-800"
              >
                Serial <span aria-hidden="true">*</span>
              </label>
              <input
                id="dev-serial"
                type="text"
                required
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                {...deviceForm.register("serialNumber")}
                className="health-form-control mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
              />
            </div>

            <div>
              <label
                htmlFor="dev-mac"
                className="block text-xs font-bold text-slate-800"
              >
                MAC Address <span aria-hidden="true">*</span>
              </label>
              <input
                id="dev-mac"
                type="text"
                required
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                {...deviceForm.register("macAddress")}
                className="health-form-control mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <div>
              <label
                htmlFor="dev-ward"
                className="block text-xs font-bold text-slate-800"
              >
                Ward <span aria-hidden="true">*</span>
              </label>
              <input
                id="dev-ward"
                type="text"
                required
                {...deviceForm.register("ward")}
                className="health-form-control mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label
                htmlFor="dev-fw"
                className="block text-xs font-bold text-slate-800"
              >
                Firmware <span aria-hidden="true">*</span>
              </label>
              <input
                id="dev-fw"
                type="text"
                required
                {...deviceForm.register("firmwareVersion")}
                className="health-form-control mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsRegisterDeviceOpen(false)}
              className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-bold text-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutations.registerDevice.isPending}
              className="rounded-lg bg-sky-700 px-3.5 py-2 text-xs font-bold text-white hover:bg-sky-600 disabled:opacity-50"
            >
              Provision
            </button>
          </div>
        </form>
      </NativeModalDialog>

      {/* MODAL 3: Add Staff */}
      <NativeModalDialog
        open={isAddStaffOpen}
        onClose={() => setIsAddStaffOpen(false)}
        title="Add Staff"
        description="Assign role in PTI Clinic."
      >
        <form
          method="POST"
          action="/api/platform"
          onSubmit={staffForm.handleSubmit(handleStaffAddSubmit)}
          className="space-y-3.5"
        >
          <div>
            <label
              htmlFor="staff-name"
              className="block text-xs font-bold text-slate-800"
            >
              Full Name <span aria-hidden="true">*</span>
            </label>
            <input
              id="staff-name"
              type="text"
              autoComplete="name"
              required
              {...staffForm.register("displayName")}
              className="health-form-control mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label
              htmlFor="staff-email"
              className="block text-xs font-bold text-slate-800"
            >
              Email <span aria-hidden="true">*</span>
            </label>
            <input
              id="staff-email"
              type="email"
              autoComplete="email"
              required
              {...staffForm.register("email")}
              className="health-form-control mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <div>
              <label
                htmlFor="staff-role"
                className="block text-xs font-bold text-slate-800"
              >
                Role <span aria-hidden="true">*</span>
              </label>
              <select
                id="staff-role"
                {...staffForm.register("role")}
                className="health-form-control mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="nurse">Nurse</option>
                <option value="doctor">Doctor</option>
                <option value="device_operator">Device Operator</option>
                <option value="hospital_admin">Hospital Admin</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="staff-dept"
                className="block text-xs font-bold text-slate-800"
              >
                Department <span aria-hidden="true">*</span>
              </label>
              <input
                id="staff-dept"
                type="text"
                required
                {...staffForm.register("department")}
                className="health-form-control mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsAddStaffOpen(false)}
              className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-bold text-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutations.addStaffMember.isPending}
              className="rounded-lg bg-sky-700 px-3.5 py-2 text-xs font-bold text-white hover:bg-sky-600 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </form>
      </NativeModalDialog>
    </div>
  );
}
