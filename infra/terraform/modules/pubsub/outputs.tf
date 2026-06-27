output "topic_ids" { value = { for k, t in google_pubsub_topic.topic : k => t.id } }
