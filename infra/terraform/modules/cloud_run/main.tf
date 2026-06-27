# Each Aegis service runs the SAME image, differentiated by SERVICE_NAME + PROCESS_TYPE,
# with autoscaling between min and max instances (scale-to-zero capable in dev).
resource "google_cloud_run_v2_service" "svc" {
  for_each = { for s in var.services : s.name => s }
  name     = "${var.prefix}-${each.value.name}"
  location = var.region

  template {
    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }
    containers {
      image = var.image
      ports { container_port = each.value.port }
      env {
        name  = "SERVICE_NAME"
        value = each.value.name
      }
      env {
        name  = "PROCESS_TYPE"
        value = "api"
      }
      env {
        name  = "AEGIS_ENV"
        value = var.env
      }
      dynamic "env" {
        for_each = var.common_env
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
}
