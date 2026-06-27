output "service_uris" {
  value = { for k, s in google_cloud_run_v2_service.svc : k => s.uri }
}
