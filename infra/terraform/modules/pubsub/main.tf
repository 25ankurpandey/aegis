# One topic + pull subscription per Aegis domain event (the cross-service event bus).
resource "google_pubsub_topic" "topic" {
  for_each = toset(var.topics)
  name     = "${var.prefix}-${each.value}"
}

resource "google_pubsub_subscription" "sub" {
  for_each             = google_pubsub_topic.topic
  name                 = "${each.value.name}-sub"
  topic                = each.value.id
  ack_deadline_seconds = 30
  retry_policy {
    minimum_backoff = "5s"
    maximum_backoff = "300s"
  }
}
