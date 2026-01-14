import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsBoolean, IsString, IsEnum, IsUUID, IsDateString, IsNumber, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { CourseStatus } from '../entities/course.entity';
import { Course } from '../entities/course.entity';

export enum SortOrder {
  ASC = 'ASC',
  DESC = 'DESC'
}

export enum SortBy {
  ORDERING = 'ordering',
  CREATED_AT = 'createdAt',
  UPDATED_AT = 'updatedAt',
  TITLE = 'title',
  START_DATETIME = 'startDatetime',
  END_DATETIME = 'endDatetime',
  FEATURED = 'featured',
  FREE = 'free'
}

export class SearchCourseDto {
  @ApiPropertyOptional({ description: 'Search keyword to match in title, description, or short description' })
  @IsOptional()
  @IsString()
  query?: string;

  @ApiPropertyOptional({ description: 'Filter by cohort ID' })
  @IsOptional()
  @IsString()
  cohortId?: string;

  @ApiPropertyOptional({ enum: CourseStatus, description: 'Filter by course status' })
  @IsOptional()
  @IsEnum(CourseStatus)
  status?: CourseStatus;

  @ApiPropertyOptional({ description: 'Filter by featured status' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  featured?: boolean;

  @ApiPropertyOptional({ description: 'Filter by free/paid status' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  free?: boolean;

  @ApiPropertyOptional({ description: 'Filter by start date (from)', type: 'string', format: 'date-time' })
  @IsOptional()
  @IsDateString()
  @Type(() => Date)
  startDateFrom?: Date;

  @ApiPropertyOptional({ description: 'Filter by start date (to)', type: 'string', format: 'date-time' })
  @IsOptional()
  @IsDateString()
  @Type(() => Date)
  startDateTo?: Date;

  @ApiPropertyOptional({ description: 'Filter by end date (from)', type: 'string', format: 'date-time' })
  @IsOptional()
  @IsDateString()
  @Type(() => Date)
  endDateFrom?: Date;

  @ApiPropertyOptional({ description: 'Filter by end date (to)', type: 'string', format: 'date-time' })
  @IsOptional()
  @IsDateString()
  @Type(() => Date)
  endDateTo?: Date;

  @ApiPropertyOptional({ description: 'Filter by creator user ID' })
  @IsOptional()
  @IsUUID()
  createdBy?: string;

  @ApiPropertyOptional({ description: 'Number of items to skip (offset)', example: 0, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  offset?: number = 0;

  @ApiPropertyOptional({ description: 'Number of items to return (limit)', example: 10, minimum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  limit?: number = 10;

  @ApiPropertyOptional({ 
    enum: SortBy, 
    description: 'Field to sort by', 
    example: SortBy.ORDERING,
    default: SortBy.ORDERING
  })
  @IsOptional()
  @IsEnum(SortBy)
  sortBy?: SortBy = SortBy.ORDERING;

  @ApiPropertyOptional({ 
    enum: SortOrder, 
    description: 'Sort order (ASC or DESC)', 
    example: SortOrder.DESC,
    default: SortOrder.DESC
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) {
      return SortOrder.DESC;
    }
    if (typeof value === 'string') {
      const upperValue = value.toUpperCase().trim();
      if (upperValue === 'ASC') {
        return SortOrder.ASC;
      }
      if (upperValue === 'DESC') {
        return SortOrder.DESC;
      }
    }
    // If it's already an enum value, return as is
    if (value === SortOrder.ASC || value === SortOrder.DESC) {
      return value;
    }
    return SortOrder.DESC;
  })
  @IsEnum(SortOrder)
  orderBy?: SortOrder = SortOrder.DESC;
}

export class SearchCourseResponseDto {
  @ApiProperty({ description: 'List of courses matching the search criteria', type: [Course] })
  courses: Course[];

  @ApiProperty({ description: 'Total number of courses matching the criteria', example: 1 })
  @IsNumber()
  totalElements: number;

  @ApiProperty({ description: 'Number of items skipped (offset)', example: 0 })
  @IsNumber()
  offset: number;

  @ApiProperty({ description: 'Number of items returned (limit)', example: 10 })
  @IsNumber()
  limit: number;
} 