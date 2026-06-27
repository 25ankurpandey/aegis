variable "prefix" { type = string }
variable "region" { type = string }
variable "env" { type = string }
variable "image" { type = string }
variable "services" {
  type = list(object({
    name = string
    port = number
  }))
}
variable "min_instances" {
  type    = number
  default = 0
}
variable "max_instances" {
  type    = number
  default = 10
}
variable "common_env" {
  type    = map(string)
  default = {}
}
