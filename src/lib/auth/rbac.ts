import { UserRole, PTI_CLINIC_ID } from "@/types/models";

export type PermissionAction =
  | "hospital:manage_settings"
  | "hospital:manage_staff"
  | "hospital:view_audit_logs"
  | "patient:register"
  | "patient:edit"
  | "patient:view"
  | "device:register"
  | "device:operate"
  | "device:view"
  | "session:create"
  | "session:complete"
  | "measurement:view"
  | "measurement:verify_offline";

const ROLE_PERMISSIONS: Record<UserRole, PermissionAction[]> = {
  super_admin: [
    "hospital:manage_settings",
    "hospital:manage_staff",
    "hospital:view_audit_logs",
    "patient:register",
    "patient:edit",
    "patient:view",
    "device:register",
    "device:operate",
    "device:view",
    "session:create",
    "session:complete",
    "measurement:view",
    "measurement:verify_offline",
  ],
  hospital_admin: [
    "hospital:manage_settings",
    "hospital:manage_staff",
    "hospital:view_audit_logs",
    "patient:register",
    "patient:edit",
    "patient:view",
    "device:register",
    "device:operate",
    "device:view",
    "session:create",
    "session:complete",
    "measurement:view",
    "measurement:verify_offline",
  ],
  doctor: [
    "patient:edit",
    "patient:view",
    "device:view",
    "session:create",
    "session:complete",
    "measurement:view",
    "measurement:verify_offline",
  ],
  nurse: [
    "patient:register",
    "patient:edit",
    "patient:view",
    "device:operate",
    "device:view",
    "session:create",
    "session:complete",
    "measurement:view",
    "measurement:verify_offline",
  ],
  device_operator: [
    "patient:view",
    "device:operate",
    "device:view",
    "session:create",
    "session:complete",
    "measurement:view",
  ],
};

export function hasPermission(role: UserRole, action: PermissionAction): boolean {
  return ROLE_PERMISSIONS[role]?.includes(action) ?? false;
}

export interface AuthenticatedActor {
  uid: string;
  email: string;
  role: UserRole;
  hospitalId: string;
  active: boolean;
  isAnonymous?: boolean;
}

export class AuthorizationError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, code = "FORBIDDEN", statusCode = 403) {
    super(message);
    this.name = "AuthorizationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Enforces single-clinic (PTI Clinic) scope and role-based permissions.
 * Multiple clinics are not supported; any request targeting a clinic other than PTI Clinic is rejected.
 */
export function enforceHospitalAccess(
  actor: AuthenticatedActor,
  targetHospitalId: string,
  requiredAction: PermissionAction
): void {
  if (!actor || !actor.uid) {
    throw new AuthorizationError("Authentication required", "UNAUTHENTICATED", 401);
  }

  if (actor.isAnonymous) {
    throw new AuthorizationError(
      "Anonymous Firebase accounts are not permitted to access PTI Clinic resources directly",
      "ANONYMOUS_REJECTED",
      403
    );
  }

  if (!actor.active) {
    throw new AuthorizationError("Staff account is inactive or suspended", "ACCOUNT_INACTIVE", 403);
  }

  if (targetHospitalId !== PTI_CLINIC_ID || actor.hospitalId !== PTI_CLINIC_ID) {
    throw new AuthorizationError(
      `Only PTI Clinic ('${PTI_CLINIC_ID}') is supported on this platform`,
      "UNSUPPORTED_CLINIC",
      403
    );
  }

  if (!hasPermission(actor.role, requiredAction)) {
    throw new AuthorizationError(
      `Role '${actor.role}' is not authorized to perform '${requiredAction}'`,
      "INSUFFICIENT_ROLE",
      403
    );
  }
}
