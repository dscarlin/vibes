locals {
  az_map = {
    for index, az in var.availability_zones : az => {
      public_cidr  = var.public_subnet_cidrs[index]
      private_cidr = var.private_subnet_cidrs[index]
      index        = index
    }
  }

  base_tags = merge(
    {
      Name         = "${var.name_prefix}-vpc"
      "managed-by" = "terraform"
    },
    var.tags
  )
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = local.base_tags
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags = merge(
    local.base_tags,
    {
      Name = "${var.name_prefix}-igw"
    }
  )
}

resource "aws_subnet" "public" {
  for_each = local.az_map

  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.key
  cidr_block              = each.value.public_cidr
  map_public_ip_on_launch = true

  tags = merge(
    local.base_tags,
    {
      Name                                        = "${var.name_prefix}-public-${each.value.index + 1}"
      "kubernetes.io/cluster/${var.cluster_name}" = "shared"
      "kubernetes.io/role/elb"                    = "1"
      "SubnetType"                                = "public"
    }
  )
}

resource "aws_subnet" "private" {
  for_each = local.az_map

  vpc_id            = aws_vpc.this.id
  availability_zone = each.key
  cidr_block        = each.value.private_cidr

  tags = merge(
    local.base_tags,
    {
      Name                                        = "${var.name_prefix}-private-${each.value.index + 1}"
      "kubernetes.io/cluster/${var.cluster_name}" = "shared"
      "kubernetes.io/role/internal-elb"           = "1"
      "SubnetType"                                = "private"
    }
  )
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags = merge(
    local.base_tags,
    {
      Name = "${var.name_prefix}-nat-eip"
    }
  )
}

resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = values(aws_subnet.public)[0].id

  tags = merge(
    local.base_tags,
    {
      Name = "${var.name_prefix}-nat"
    }
  )

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = merge(
    local.base_tags,
    {
      Name = "${var.name_prefix}-public-rt"
    }
  )
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this.id
  }

  tags = merge(
    local.base_tags,
    {
      Name = "${var.name_prefix}-private-rt"
    }
  )
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  for_each = aws_subnet.private

  subnet_id      = each.value.id
  route_table_id = aws_route_table.private.id
}
