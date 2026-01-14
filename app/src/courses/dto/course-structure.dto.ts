import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsNumber, IsOptional, IsUUID, ValidateNested, ArrayMinSize, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { VALIDATION_MESSAGES } from '../../common/constants/response-messages.constant';

export class LessonStructureDto {
  @ApiProperty({
    description: 'Lesson ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsNotEmpty({ message: VALIDATION_MESSAGES.COMMON.REQUIRED('Lesson ID') })
  @IsUUID('4', { message: VALIDATION_MESSAGES.COMMON.UUID('Lesson ID') })
  lessonId: string;

  @ApiProperty({
    description: 'Order/position of the lesson within the module',
    example: 1,
    minimum: 0,
  })
  @IsNotEmpty({ message: VALIDATION_MESSAGES.COMMON.REQUIRED('Lesson order') })
  @IsNumber({}, { message: VALIDATION_MESSAGES.COMMON.NUMBER('Lesson order') })
  @Min(0, { message: VALIDATION_MESSAGES.COMMON.MIN_VALUE('Lesson order', 0) })
  order: number;
}

export class ModuleStructureDto {
  @ApiProperty({
    description: 'Module ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsNotEmpty({ message: VALIDATION_MESSAGES.COMMON.REQUIRED('Module ID') })
  @IsUUID('4', { message: VALIDATION_MESSAGES.COMMON.UUID('Module ID') })
  moduleId: string;

  @ApiProperty({
    description: 'Order/position of the module within the course',
    example: 1,
    minimum: 0,
  })
  @IsNotEmpty({ message: VALIDATION_MESSAGES.COMMON.REQUIRED('Module order') })
  @IsNumber({}, { message: VALIDATION_MESSAGES.COMMON.NUMBER('Module order') })
  @Min(0, { message: VALIDATION_MESSAGES.COMMON.MIN_VALUE('Module order', 0) })
  order: number;

  @ApiProperty({
    description: 'Lessons within this module',
    type: [LessonStructureDto],
    example: [
      { lessonId: '123e4567-e89b-12d3-a456-426614174001', order: 1 },
      { lessonId: '123e4567-e89b-12d3-a456-426614174002', order: 2 }
    ],
  })
  @IsOptional()
  @IsArray({ message: VALIDATION_MESSAGES.COMMON.ARRAY('Lessons') })
  @ValidateNested({ each: true })
  @Type(() => LessonStructureDto)
  lessons?: LessonStructureDto[];
}

export class CourseStructureDto {
  @ApiProperty({
    description: 'Modules in the course with their structure',
    type: [ModuleStructureDto],
    example: [
      {
        moduleId: '123e4567-e89b-12d3-a456-426614174001',
        order: 1,
        lessons: [
          { lessonId: '456e7890-e89b-12d3-a456-426614174001', order: 1 },
          { lessonId: '456e7890-e89b-12d3-a456-426614174002', order: 2 }
        ]
      },
      {
        moduleId: '123e4567-e89b-12d3-a456-426614174002',
        order: 2,
        lessons: [
          { lessonId: '456e7890-e89b-12d3-a456-426614174003', order: 1 }
        ]
      }
    ],
  })
  @IsNotEmpty({ message: VALIDATION_MESSAGES.COMMON.REQUIRED('Modules') })
  @IsArray({ message: VALIDATION_MESSAGES.COMMON.ARRAY('Modules') })
  @ArrayMinSize(1, { message: VALIDATION_MESSAGES.COMMON.MIN_ARRAY_LENGTH('Modules', 1) })
  @ValidateNested({ each: true })
  @Type(() => ModuleStructureDto)
  modules: ModuleStructureDto[];
}

export class CourseOrderDto {
  @ApiProperty({
    description: 'Course ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsNotEmpty({ message: VALIDATION_MESSAGES.COMMON.REQUIRED('Course ID') })
  @IsUUID('4', { message: VALIDATION_MESSAGES.COMMON.UUID('Course ID') })
  courseId: string;

  @ApiProperty({
    description: 'Order/position of the course',
    example: 1,
    minimum: 0,
  })
  @IsNotEmpty({ message: VALIDATION_MESSAGES.COMMON.REQUIRED('Course order') })
  @IsNumber({}, { message: VALIDATION_MESSAGES.COMMON.NUMBER('Course order') })
  @Min(0, { message: VALIDATION_MESSAGES.COMMON.MIN_VALUE('Course order', 0) })
  order: number;
}

export class BulkCourseOrderDto {
  @ApiProperty({
    description: 'Courses with their order',
    type: [CourseOrderDto],
    example: [
      { courseId: '123e4567-e89b-12d3-a456-426614174000', order: 1 },
      { courseId: '123e4567-e89b-12d3-a456-426614174001', order: 2 },
      { courseId: '123e4567-e89b-12d3-a456-426614174002', order: 3 }
    ],
  })
  @IsNotEmpty({ message: VALIDATION_MESSAGES.COMMON.REQUIRED('Courses') })
  @IsArray({ message: VALIDATION_MESSAGES.COMMON.ARRAY('Courses') })
  @ArrayMinSize(1, { message: VALIDATION_MESSAGES.COMMON.MIN_ARRAY_LENGTH('Courses', 1) })
  @ValidateNested({ each: true })
  @Type(() => CourseOrderDto)
  courses: CourseOrderDto[];
} 