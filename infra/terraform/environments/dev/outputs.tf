output "service_uris" { value = module.services.service_uris }
output "db_connection_name" { value = module.database.instance_connection_name }
output "event_topics" { value = module.pubsub.topic_ids }
