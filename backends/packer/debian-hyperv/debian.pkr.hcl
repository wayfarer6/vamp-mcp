packer {
  required_version = ">= 1.16.2"
  required_plugins {
    hyperv = {
      source  = "github.com/hashicorp/hyperv"
      version = "= 1.1.5"
    }
  }
}

variable "dvd_path" { type = string }
variable "dvd_sha256" { type = string }
variable "job_dir" { type = string }
variable "vm_name" { type = string }
variable "switch_name" { type = string }
variable "memory_mb" {
  type    = number
  default = 2048
}
variable "cpus" {
  type    = number
  default = 2
}
variable "disk_mb" {
  type    = number
  default = 32768
}

source "hyperv-iso" "debian" {
  vm_name              = var.vm_name
  generation           = 2
  enable_secure_boot   = false
  enable_tpm           = false
  switch_name          = var.switch_name
  iso_url              = var.dvd_path
  iso_checksum         = "sha256:${var.dvd_sha256}"
  secondary_iso_images = ["${var.job_dir}/setup.iso"]
  temp_path            = "${var.job_dir}/temporary"
  output_directory     = "${var.job_dir}/export"
  communicator         = "none"
  headless             = true
  boot_wait            = "10s"
  shutdown_timeout     = "20m"
  disable_shutdown     = true
  memory               = var.memory_mb
  cpus                 = var.cpus
  disk_size            = var.disk_mb
  skip_compaction      = true
  boot_command = [
    "c<wait>",
    "search --label VAMP_SETUP --set=vamp<enter><wait>",
    "linux /install.amd/vmlinuz auto=true priority=critical<enter>",
    "initrd /install.amd/initrd.gz ($vamp)/vampboot.gz<enter>",
    "boot<enter>",
  ]
}

build {
  sources = ["source.hyperv-iso.debian"]
}
