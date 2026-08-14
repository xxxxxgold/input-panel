import { invoke } from "@tauri-apps/api/core";

import type { SitePublicEndpointsPayload } from "../../types";
import { isTauriRuntime, request } from "../../shared/transport/runtime";

export function getSitePublicEndpoints(siteId: string) {
  if (isTauriRuntime()) {
    return invoke<SitePublicEndpointsPayload | null>("get_site_public_endpoints", { siteId });
  }
  return request<SitePublicEndpointsPayload | null>(`/api/sites/${siteId}/public-endpoints`);
}

export function syncSitePublicEndpoints(siteId: string) {
  if (isTauriRuntime()) {
    return invoke<SitePublicEndpointsPayload>("sync_site_public_endpoints", { siteId });
  }
  return request<SitePublicEndpointsPayload>(`/api/sites/${siteId}/public-endpoints`, {
    method: "POST"
  });
}

export function pingSitePublicEndpoints(siteId: string) {
  if (isTauriRuntime()) {
    return invoke<SitePublicEndpointsPayload>("ping_site_public_endpoints", { siteId });
  }
  return request<SitePublicEndpointsPayload>(`/api/sites/${siteId}/public-endpoints/ping`, {
    method: "POST"
  });
}
