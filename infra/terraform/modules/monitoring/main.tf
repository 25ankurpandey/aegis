resource "google_monitoring_uptime_check_config" "gateway" {
  display_name = "${var.prefix}-gateway-health"
  timeout      = "10s"
  http_check {
    path    = "/health"
    port    = 443
    use_ssl = true
  }
  monitored_resource {
    type   = "uptime_url"
    labels = { host = var.gateway_host }
  }
}

resource "google_monitoring_alert_policy" "gateway_down" {
  display_name = "${var.prefix}-gateway-down"
  combiner     = "OR"
  conditions {
    display_name = "Gateway uptime failing"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\""
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_FRACTION_TRUE"
      }
    }
  }
}
